import type { ReactNode } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, ChevronUp, GripVertical } from "lucide-react";
import type { FallbackRungKind } from "@traycer/protocol/host/fallback-policy";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SETTINGS_ROW_STACK } from "@/components/settings/settings-row-layout";
import { FALLBACK_RUNG_COPY } from "@/components/settings/panels/fallback/fallback-rung-copy";
import { cn } from "@/lib/utils";

export interface FallbackLadderEditorProps {
  /** All four steps in render order, enabled or not. */
  readonly displayOrder: readonly FallbackRungKind[];
  readonly enabled: ReadonlySet<FallbackRungKind>;
  readonly onToggle: (rung: FallbackRungKind, next: boolean) => void;
  /** Indices are positions among the MOVABLE steps, not into `displayOrder`. */
  readonly onMove: (fromIndex: number, toIndex: number) => void;
  /**
   * Rendered on the profile step when the user has no second account anywhere
   * that step could use it. An inert step that says nothing is the worst of the
   * three states - the user turns it on and it silently never fires.
   */
  readonly profileStepHint: ReactNode;
}

/**
 * The "Try these in order" editor.
 *
 * Two reorder mechanisms on purpose. Drag is the one people reach for, and no
 * other settings panel has it - which is exactly why the ▲▼ buttons are not
 * optional: a pointer drag is unreachable from a keyboard and awkward on touch,
 * and this list is the whole configuration of the feature. The buttons are the
 * keyboard and touch path, so no `KeyboardSensor` is registered; two competing
 * keyboard gestures over one list would be worse than one that is announced.
 *
 * `notify` never moves. It has no handle and no arrows because it is the step
 * that runs when nothing else worked, and the panel offers no way to place it
 * earlier. It is still rendered at its STORED position rather than forced to
 * the end: the wire format can place it anywhere, and drawing a policy
 * differently from how the engine will walk it is worse than an unusual-looking
 * row. Everything this panel writes puts it last.
 */
export function FallbackLadderEditor(
  props: FallbackLadderEditorProps,
): ReactNode {
  const { displayOrder, enabled, onToggle, onMove, profileStepHint } = props;
  const movable = displayOrder.filter((rung) => rung !== "notify");
  // A small distance constraint so a click on the row's switch or arrows is
  // never swallowed by a drag that started on the same pointer-down.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    if (over === null || active.id === over.id) return;
    const from = movableIndexOf(active.id, movable);
    const to = movableIndexOf(over.id, movable);
    if (from === -1 || to === -1) return;
    onMove(from, to);
  };

  return (
    <div className="space-y-1.5">
      <div className="font-medium text-ui-xs text-muted-foreground">
        Try these in order
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={[...movable]}
          strategy={verticalListSortingStrategy}
        >
          <ul className="flex flex-col gap-1.5">
            {displayOrder.map((rung) => {
              // `movableIndexOf`, not `movable.indexOf(rung)`: TS infers a type
              // predicate for the `!== "notify"` filter above, so `movable` is
              // the NARROW union and `indexOf` refuses the one element this
              // needs to ask about. The helper takes the wide id and returns
              // the same `-1` the fixed step's row already expects.
              const movableIndex = movableIndexOf(rung, movable);
              return (
                <li key={rung}>
                  <FallbackLadderRow
                    rung={rung}
                    enabled={enabled.has(rung)}
                    onToggle={(next) => {
                      onToggle(rung, next);
                    }}
                    movableIndex={movableIndex}
                    movableCount={movable.length}
                    onMove={onMove}
                    hint={rung === "profile" ? profileStepHint : null}
                  />
                </li>
              );
            })}
          </ul>
        </SortableContext>
      </DndContext>
      <p className="text-ui-xs text-muted-foreground">
        Turning a step off keeps it here, but its place in the order is only
        remembered while it is on - a step you turn off moves to the end next
        time you open this page.
      </p>
    </div>
  );
}

/**
 * dnd-kit identifies items by `UniqueIdentifier` (`string | number`), so an id
 * coming back off an event is wider than the union that went in. Comparing
 * against the list that was handed to `SortableContext` recovers the position
 * without a cast, and answers `-1` for anything that is not one of ours.
 */
function movableIndexOf(
  id: string | number,
  movable: readonly FallbackRungKind[],
): number {
  return movable.findIndex((rung) => rung === id);
}

function FallbackLadderRow(props: {
  readonly rung: FallbackRungKind;
  readonly enabled: boolean;
  readonly onToggle: (next: boolean) => void;
  /** `-1` for the fixed `notify` step. */
  readonly movableIndex: number;
  readonly movableCount: number;
  readonly onMove: (fromIndex: number, toIndex: number) => void;
  readonly hint: ReactNode;
}): ReactNode {
  const { rung, enabled, onToggle, movableIndex, movableCount, onMove, hint } =
    props;
  const copy = FALLBACK_RUNG_COPY[rung];
  const fixed = movableIndex === -1;
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: rung, disabled: fixed });

  return (
    <div
      ref={fixed ? undefined : setNodeRef}
      style={
        fixed
          ? undefined
          : { transform: CSS.Transform.toString(transform), transition }
      }
      className={cn(
        // An alpha of the foreground, never `bg-muted`: these rows sit inside
        // the group's card, where every flat preset collapses muted into the
        // card's own fill and the row would disappear.
        "flex flex-wrap items-start gap-x-3 gap-y-2 rounded-md border border-border/40 bg-foreground/3 px-3 py-2.5",
        SETTINGS_ROW_STACK.container,
        isDragging && "opacity-60",
      )}
    >
      <div className="flex shrink-0 items-center gap-0.5 pt-0.5">
        {fixed ? (
          // A reserved, empty gutter rather than no gutter: the fixed step has
          // to line up with the movable ones above it, and a row that shifts
          // left reads as a different kind of thing rather than as one that
          // cannot move.
          <span aria-hidden className="inline-block size-6" />
        ) : (
          <span
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            className="inline-flex size-6 cursor-grab items-center justify-center rounded text-muted-foreground/70 hover:text-foreground"
            aria-label={`Reorder ${copy.label}`}
          >
            <GripVertical className="size-3.5" />
          </span>
        )}
        {fixed ? (
          // Reserved gutters, NOT disabled buttons - the same distinction the
          // overrides matrix makes with its ineligible chips. A disabled
          // control says "not right now"; this step can never move, and
          // offering two greyed arrows on every render invites the reader to
          // look for the state that would enable them. Absence says it once.
          <>
            <span aria-hidden className="inline-block size-6" />
            <span aria-hidden className="inline-block size-6" />
          </>
        ) : (
          <>
            <ReorderButton
              direction="up"
              label={copy.label}
              disabled={movableIndex <= 0}
              onClick={() => {
                onMove(movableIndex, movableIndex - 1);
              }}
            />
            <ReorderButton
              direction="down"
              label={copy.label}
              disabled={movableIndex >= movableCount - 1}
              onClick={() => {
                onMove(movableIndex, movableIndex + 1);
              }}
            />
          </>
        )}
      </div>
      <div
        className={cn("min-w-[50%] flex-1 space-y-1", SETTINGS_ROW_STACK.label)}
      >
        <div
          className={cn(
            "font-medium",
            fixed ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {copy.label}
        </div>
        <p className="max-w-[72ch] text-pretty text-ui-sm text-muted-foreground">
          {copy.description}
        </p>
        {hint}
      </div>
      <div
        className={cn(
          "ml-auto flex shrink-0 items-center",
          SETTINGS_ROW_STACK.control,
        )}
      >
        <Switch
          checked={enabled}
          onCheckedChange={onToggle}
          aria-label={`${copy.label} - run this step`}
        />
      </div>
    </div>
  );
}

function ReorderButton(props: {
  readonly direction: "up" | "down";
  readonly label: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
}): ReactNode {
  const { direction, label, disabled, onClick } = props;
  const Icon = direction === "up" ? ChevronUp : ChevronDown;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-6 text-muted-foreground/70"
      disabled={disabled}
      onClick={onClick}
      aria-label={`Move ${label} ${direction}`}
    >
      <Icon className="size-3.5" />
    </Button>
  );
}
