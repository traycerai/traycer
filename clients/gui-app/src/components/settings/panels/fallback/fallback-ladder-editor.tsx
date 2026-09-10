import { useId, type ReactNode } from "react";
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
import { fallbackMovableBoundary } from "@/components/settings/panels/fallback/fallback-policy-draft";
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
 * keyboard gestures over one list would be worse than one.
 *
 * That decision has a consequence the handle has to carry: since the drag is
 * POINTER ONLY, the handle is hidden from assistive technology and is not in
 * the tab order, and the list's own instruction paragraph names the buttons as
 * the way to reorder. dnd-kit's default handle attributes say the opposite -
 * they promise a space-bar-and-arrows gesture nothing implements - so they are
 * not spread. See the handle itself.
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
  const headingId = useId();
  const instructionsId = useId();
  const movable = displayOrder.filter((rung) => rung !== "notify");
  // How many movable rows sit above the fixed step. `movable.length` for every
  // ladder this panel writes, since `notify` is last there and nothing is below
  // it; smaller only for an externally authored early `notify`, which is the one
  // case where a move has a boundary to cross. See `moveFallbackRung`.
  const boundary = fallbackMovableBoundary(displayOrder);
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
      <div
        id={headingId}
        className="font-medium text-ui-xs text-muted-foreground"
      >
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
          {/* Named and described, which is what makes the hidden drag handle
              honest rather than merely silent: entering this list says what it
              is and how to reorder it, and the "how" names the buttons that
              actually work. The instruction paragraph is the visible one below
              - one sentence, not a second copy for screen readers, so the two
              cannot drift. */}
          <ul
            className="flex flex-col gap-1.5"
            aria-labelledby={headingId}
            aria-describedby={instructionsId}
          >
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
                    movableBoundary={boundary}
                    onMove={onMove}
                    hint={rung === "profile" ? profileStepHint : null}
                  />
                </li>
              );
            })}
          </ul>
        </SortableContext>
      </DndContext>
      <p id={instructionsId} className="text-ui-xs text-muted-foreground">
        {/* First sentence added for AX7: the drag handle is a mouse
            affordance and says nothing to a screen reader, so the way to
            reorder has to be stated where entering the list will reach it. */}
        Use each step&apos;s Move up and Move down buttons to reorder, or drag
        it by its handle. Turning a step off keeps it here, and turning it back
        on puts it back where it was. Only its saved position is lost: next time
        you open this page a step that is off sits just above &ldquo;
        {FALLBACK_RUNG_COPY.notify.label}&rdquo; - never below it, where turning
        it on again would leave it unable to run.
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
  /** Movable rows above the fixed step; see `fallbackMovableBoundary`. */
  readonly movableBoundary: number;
  readonly onMove: (fromIndex: number, toIndex: number) => void;
  readonly hint: ReactNode;
}): ReactNode {
  const {
    rung,
    enabled,
    onToggle,
    movableIndex,
    movableCount,
    movableBoundary,
    onMove,
    hint,
  } = props;
  const copy = FALLBACK_RUNG_COPY[rung];
  const fixed = movableIndex === -1;
  // `attributes` is deliberately not taken. It is the half of `useSortable`
  // that advertises a keyboard drag, and this editor registers no
  // `KeyboardSensor` - see the handle below.
  const {
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
          // POINTER ONLY, and hidden from assistive technology for that
          // reason - the AX7 finding. `{...attributes}` is what is missing
          // here rather than what was added: dnd-kit's defaults put
          // `role="button"`, `tabIndex={0}`, `aria-roledescription="sortable"`
          // and an `aria-describedby` pointing at its own screen-reader
          // instructions on this span. Those instructions say to press the
          // space bar and use the arrow keys, and no `KeyboardSensor` is
          // registered to implement them - deliberately, see this editor's own
          // doc block: the ▲▼ buttons are the keyboard and touch path, and two
          // competing keyboard gestures over one list would be worse than one.
          //
          // So the handle advertised a gesture that does nothing, to exactly
          // the users who cannot use the gesture it does have. Spreading only
          // `listeners` keeps the pointer drag (PointerSensor's
          // `onPointerDown`) and drops every promise. `aria-hidden` with no
          // label completes it: this is a grip affordance for a mouse, the
          // real control is the pair of buttons beside it, and the list's
          // instruction paragraph below says so where an AT user will reach
          // it.
          <span
            ref={setActivatorNodeRef}
            {...listeners}
            aria-hidden
            className="inline-flex size-6 cursor-grab items-center justify-center rounded text-muted-foreground/70 hover:text-foreground"
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
            {/* The second clause on each is the `notify` boundary, and unlike
                the fixed step's reserved gutters these ARE disabled buttons:
                "not right now" is exactly right here. The row can move, just
                not across the terminal step, and every other row in the list
                has the same two arrows in the same places. It cannot fire on a
                ladder this panel wrote - `notify` is last there, so `boundary`
                is the movable count and the first clause already covers the
                last row - and only an externally authored early `notify` ever
                greys one out. `moveFallbackRung` refuses the same move
                independently; this is what stops it being refused silently. */}
            <ReorderButton
              direction="up"
              label={copy.label}
              disabled={movableIndex <= 0 || movableIndex === movableBoundary}
              onClick={() => {
                onMove(movableIndex, movableIndex - 1);
              }}
            />
            <ReorderButton
              direction="down"
              label={copy.label}
              disabled={
                movableIndex >= movableCount - 1 ||
                movableIndex === movableBoundary - 1
              }
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
        {fixed ? (
          <FixedStepControl
            label={copy.label}
            enabled={enabled}
            onToggle={onToggle}
          />
        ) : (
          <Switch
            checked={enabled}
            onCheckedChange={onToggle}
            aria-label={`${copy.label} - run this step`}
          />
        )}
      </div>
    </div>
  );
}

/**
 * What the terminal `notify` step offers instead of a switch.
 *
 * It had the same `Switch` as every other row, sitting beside copy that says
 * "Always runs when nothing else worked" - two statements that cannot both be
 * true, and the one a first-time user believes is the switch. They read it as a
 * notification preference; it is nothing of the kind. Turning it off does not
 * suppress a single notification: exhaustion still ends in the same terminal
 * consequences and the error card is always published. What it actually changes
 * is engine traversal configuration - whether a notify-only grace hold arms -
 * which is not a choice this page has any way to explain.
 *
 * So the ordinary state offers no control at all, matching the reserved gutters
 * this row already renders in place of a drag handle and arrows: absence says
 * "this cannot be changed" once, where a disabled switch would invite the
 * reader to look for the state that enables it.
 *
 * The step CAN still be absent from a stored ladder - the wire format allows it
 * and a policy written before this rule, or by something other than this panel,
 * may have it - and the row keeps rendering that honestly rather than drawing a
 * step that is not there. The affordance offered then is one-way: a link that
 * puts the step back. There is deliberately no path from here to turning it
 * off, so nothing on this page can imply the always-published error card is
 * something a user has switched on.
 */
function FixedStepControl(props: {
  readonly label: string;
  readonly enabled: boolean;
  readonly onToggle: (next: boolean) => void;
}): ReactNode {
  const { label, enabled, onToggle } = props;
  if (enabled) {
    return (
      <span
        className="text-ui-sm text-muted-foreground"
        data-testid="fallback-step-always-on"
      >
        Always
      </span>
    );
  }
  return (
    <Button
      type="button"
      variant="link"
      className="h-auto p-0 text-ui-sm"
      aria-label={`${label} - add this step back`}
      onClick={() => {
        onToggle(true);
      }}
    >
      Add this step back
    </Button>
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
