import {
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  ChevronRight,
  GripVertical,
  Rows2,
  X,
  type LucideIcon,
} from "lucide-react";
import { armLayoutDrag } from "@/components/layout-editor/canvas/drag-engine";
import { useLayoutFormHost } from "@/components/layout-editor/inspector/layout-form-host";
import {
  sortableRowPadding,
  type SortableRowPadding,
} from "@/components/layout-editor/inspector/sortable-row-padding";
import { Button } from "@/components/ui/button";
import { movedWithin } from "@/lib/layout/layout-arrangement";
import { cn } from "@/lib/utils";
import { useSettingsDensity } from "@/providers/settings-density-context";

/**
 * Generic in its id, so each order group passes its OWN union - region ids for
 * the dock and the toolbars, provider ids for the usage list, ids-or-divider
 * ids for the rail. A reorder therefore hands the caller back exactly the ids
 * it put in, and the re-narrowing helper that used to sit on the other side of
 * a widened `string` is gone (G1-23).
 */
export interface SortableListItem<Id extends string> {
  readonly id: Id;
  readonly label: string;
  readonly icon: LucideIcon | null;
  /** A provider's logo in place of the registry's icon, else `null`. */
  readonly glyph: ReactNode;
  /** A divider (L-155) rather than a region: a rule, with no state. */
  readonly divider: boolean;
  /**
   * Whether this row can be picked up at all.
   *
   * `false` for the rail's stack link and nothing else (L-168): the link is
   * not a member the user places, it is the join between the two panels around
   * it, and it moves when they do. A row that cannot move carries no grab, no
   * grip and no reorder keys, so the list never offers a gesture that would
   * write nothing.
   */
  readonly movable: boolean;
  /** Drawn muted: the member is hidden. */
  readonly dimmed: boolean;
  /**
   * The presence rule (L-47), where one exists. Drawn as the first line of the
   * row's DISCLOSURE rather than under its name (R3-08): a hint that is
   * sometimes there and sometimes not gave one list three row heights, and a
   * rule about when a panel appears is exactly the kind of thing a row opens to
   * explain. It stays the grab's description either way, so a screen reader
   * still hears it without opening anything.
   */
  readonly hint: string | null;
  /** The row's ONE state control (L-121), or `null` for a divider or link. */
  readonly control: ReactNode;
  /**
   * Putting this row back, drawn after the row's name while it differs from
   * what shipped - which is also how the row says it changed. Kept apart from
   * {@link SortableListItem.control} so a value changing never moves the
   * control column (LV2-11).
   */
  readonly revert: ReactNode;
  /** What this row's disclosure opens IN PLACE (L-89), or `null` for none. */
  readonly detail: ReactNode;
  readonly open: boolean;
  /**
   * What pressing the row does: open or close its disclosure, or, on a row
   * with none, whatever the host makes of it (the editor selects the region).
   * `null` for a row that does nothing when pressed.
   */
  readonly onToggleOpen: (() => void) | null;
  /** Taking the item out of the list altogether: a rail divider or a stack link. */
  readonly onRemove: (() => void) | null;
  /**
   * What the Remove button is CALLED, where "Remove <name>" does not read as
   * English: the stack link's name is a sentence about the panel above it, so
   * its verb names the thing being undone instead ("Remove stack").
   */
  readonly removeLabel: string | null;
  /**
   * Joining this row to the one below it, for the rail's panels (L-168): the
   * counterpart of the link row's Remove, offered on the panel ABOVE where a
   * link could go and nowhere else.
   */
  readonly onStack: (() => void) | null;
  /**
   * A stack row's members (L-181), each with its own way out of the stack, or
   * `null` on every other row.
   */
  readonly stackMembers: ReadonlyArray<SortableStackMember> | null;
}

/** One member listed on a stack row, and taking it out of the stack. */
export interface SortableStackMember {
  readonly id: string;
  readonly label: string;
  readonly onUnstack: () => void;
}

interface SortableListProps<Id extends string> {
  readonly items: ReadonlyArray<SortableListItem<Id>>;
  /**
   * What this list is, for the `role="group"` around it: a page with six lists
   * on it has to tell a screen reader which one a row belongs to, and the
   * card's heading is not in the row's own context.
   */
  readonly label: string;
  readonly selectedId: string | null;
  /**
   * One item's new index in this list. The caller writes it as one gesture.
   *
   * `null` for a list with no order of its own - the Chat and Status bar cards
   * are two rows that cannot be rearranged - and then the rows carry no handle,
   * no grab and no reorder keys. One row component, drawn the same way whether
   * or not the list it is in happens to be ordered.
   */
  readonly onMove: ((id: Id, toIndex: number) => void) | null;
}

/** The operation every row carries, stated on the row rather than on the grab. */
const GRAB_INSTRUCTIONS =
  "Press space to pick up, arrow keys to move, space to drop, escape to cancel.";

/** Where a grabbed item started, and where the arrows have taken it so far. */
interface KeyboardGrab<Id extends string> {
  readonly id: Id;
  readonly from: number;
  readonly to: number;
}

/**
 * The layout form's one row list (L-24, L-95), the same in both hosts: every
 * row carries its control, its reserved revert, extra and chevron slots, and a
 * disclosure that opens in place. The editor's canvas selection is the
 * `selectedId` row.
 *
 * Three ways to move an item, all landing on the same one-index-at-a-time
 * write:
 *
 * - a pointer drag on the same engine the canvas uses, so the two feel alike;
 * - Alt+ArrowUp/Down, which nudges by one and commits at once (L-31);
 * - Space to grab, arrows to move, Space to drop and Escape to put it back,
 *   which is the path that works without a pointer and without knowing the
 *   modifier. The grab moves nothing until it is dropped, exactly as the drag
 *   writes nothing until the release, and it is never animated (L-29).
 */
export function SortableList<Id extends string>(
  props: SortableListProps<Id>,
): ReactNode {
  const { items, label, selectedId, onMove } = props;
  const host = useLayoutFormHost();
  const page = host === "page";
  const compact = useSettingsDensity() === "compact";
  const listRef = useRef<HTMLDivElement | null>(null);
  const instructionsId = useId();
  const [grab, setGrab] = useState<KeyboardGrab<Id> | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const ordered = onMove !== null;
  const gutter = sortableRowPadding(page, compact);

  // While an item is grabbed the list draws where it WOULD land. Nothing is
  // written until the drop, so Escape is a true cancel and the whole move is
  // one history entry however many arrow presses it took.
  const shown = grab === null ? items : movedWithin(items, grab.from, grab.to);

  function cancelGrab(current: KeyboardGrab<Id>, itemLabel: string): void {
    setGrab(null);
    setAnnouncement(
      positionMessage(
        "Cancelled, returned",
        itemLabel,
        current.from,
        items.length,
      ),
    );
  }

  /**
   * Both gestures are bound on the list natively rather than as props on each
   * row, and Escape is why.
   *
   * A cancelled grab is a rung of the Escape ladder in its own right, and it
   * has to be settled before any ANCESTOR sees the key. Bound natively on the
   * list, it is settled at the deepest point there is and its
   * `stopPropagation` holds whatever else is listening above - the editor's
   * own ladder (now `document`, I-02), the shell, a future layer - without
   * depending on where React happens to delegate its handlers. Click
   * follows keydown here so that the two read together and so the row keeps
   * its keyboard operation without an `onClick` prop that has no `onKeyDown`
   * beside it.
   */
  useEffect(() => {
    const list = listRef.current;
    if (list === null) return;

    function rowItem(
      event: Event,
    ): { item: SortableListItem<Id>; index: number } | null {
      const target = event.target;
      if (!(target instanceof Element)) return null;
      // A control in the row is a control, not the row - and everything the
      // row's disclosure opened is the DETAIL's, not the row's. Without the
      // second test a space pressed on a checkbox label inside an expanded
      // card would pick the whole row up (L-95's in-place levels).
      if (target.closest(ROW_CONTROL_SELECTOR) !== null) return null;
      if (target.closest(DETAIL_SELECTOR) !== null) return null;
      const id = target
        .closest("[data-sortable-id]")
        ?.getAttribute("data-sortable-id");
      const index = items.findIndex((candidate) => candidate.id === id);
      if (index < 0) return null;
      return { item: items[index], index };
    }

    function announce(verb: string, label: string, index: number): void {
      setAnnouncement(positionMessage(verb, label, index, items.length));
    }

    function handleSpace(item: SortableListItem<Id>, index: number): void {
      if (grab === null) {
        setGrab({ id: item.id, from: index, to: index });
        // What to do next is on the row already (`GRAB_INSTRUCTIONS`), so the
        // grab only has to say what happened.
        announce("Grabbed", item.label, index);
        return;
      }
      setGrab(null);
      announce("Dropped", item.label, grab.to);
      if (grab.to !== grab.from) onMove?.(grab.id, grab.to);
    }

    function handleArrow(
      item: SortableListItem<Id>,
      index: number,
      delta: number,
    ): void {
      if (grab !== null) {
        const to = stepPastFixed(items, grab.to, delta);
        if (to === grab.to) return;
        setGrab({ ...grab, to });
        announce("Moved", item.label, to);
        return;
      }
      const to = stepPastFixed(items, index, delta);
      if (to === index) return;
      announce("Moved", item.label, to);
      onMove?.(item.id, to);
    }

    function handleKeyDown(event: KeyboardEvent): void {
      const row = rowItem(event);
      if (row === null) return;
      if (grab !== null && grab.id !== row.item.id) return;
      const arrow = arrowDelta(event.key);
      // An unmovable row keeps Enter and its own activation and loses the
      // reorder gestures entirely: the stack link moves with its panels.
      const rowOrdered = ordered && row.item.movable;
      if (event.key === " " && !rowOrdered) {
        // An unordered list has nothing to grab, so Space is the row's own
        // activation - the same thing Enter and a click do.
        event.preventDefault();
        activate(row.item);
      } else if (event.key === " ") {
        event.preventDefault();
        handleSpace(row.item, row.index);
      } else if (event.key === "Enter") {
        event.preventDefault();
        activate(row.item);
      } else if (event.key === "Escape" && grab !== null) {
        event.preventDefault();
        event.stopPropagation();
        cancelGrab(grab, row.item.label);
      } else if (
        arrow !== null &&
        rowOrdered &&
        (grab !== null || event.altKey)
      ) {
        // Without a grab the arrows belong to the index's own walk unless the
        // modifier L-31 names is held.
        event.preventDefault();
        handleArrow(row.item, row.index, arrow);
      }
    }

    function handleClick(event: MouseEvent): void {
      if (grab !== null) return;
      const row = rowItem(event);
      if (row !== null) activate(row.item);
    }

    list.addEventListener("keydown", handleKeyDown);
    list.addEventListener("click", handleClick);
    return () => {
      list.removeEventListener("keydown", handleKeyDown);
      list.removeEventListener("click", handleClick);
    };
  });

  function handlePointerDown(
    event: ReactPointerEvent<HTMLDivElement>,
    item: SortableListItem<Id>,
  ): void {
    const id = item.id;
    if (grab !== null || !ordered || !item.movable) return;
    // A control in the row is a control, not a handle.
    if (
      event.target instanceof Element &&
      event.target.closest(ROW_CONTROL_SELECTOR) !== null
    )
      return;
    // A finger is a scroll everywhere but the grip (the line is
    // `touch-pan-y`), so a list that fills a phone's screen still scrolls
    // under it; a mouse or a pen still picks the row up from anywhere on it.
    if (
      event.pointerType === "touch" &&
      !(
        event.target instanceof Element &&
        event.target.closest(ROW_GRIP_SELECTOR) !== null
      )
    )
      return;
    armLayoutDrag({
      event: event.nativeEvent,
      resolve: () => {
        const rows = rowsOf(listRef.current);
        const index = rows.findIndex(
          (node) => node.getAttribute("data-sortable-id") === id,
        );
        return index < 0 ? null : { items: rows, index, clamp: null };
      },
      onDrop: (_fromIndex, toIndex) => {
        onMove(id, toIndex);
      },
    });
  }

  return (
    <>
      {/* Said before it is needed, not after: the instructions used to reach a
          screen reader only once Space had already been pressed, which left
          every row announced as an unnamed focusable group with no stated
          operation (G3-18). One static line, described by every row. */}
      {ordered ? (
        <p id={instructionsId} className="sr-only">
          {GRAB_INSTRUCTIONS}
        </p>
      ) : null}
      {/* One surface with rows in it, not a stack of cards in a card: the row
          is the card's own row, ruled off from the next exactly as
          `SettingsRow` is, and it lifts only while it is being held. */}
      <div
        ref={listRef}
        role="group"
        aria-label={label}
        className="flex flex-col"
      >
        {shown.map((item) => (
          <SortableRow
            key={item.id}
            item={item}
            instructionsId={ordered ? instructionsId : null}
            page={page}
            gutter={gutter}
            selected={item.id === selectedId}
            grabbed={grab?.id === item.id}
            onPointerDown={(event) => {
              handlePointerDown(event, item);
            }}
            onBlur={() => {
              if (grab !== null && grab.id === item.id)
                cancelGrab(grab, item.label);
            }}
          />
        ))}
      </div>
      {ordered ? (
        <p className="sr-only" role="status" aria-live="polite">
          {announcement}
        </p>
      ) : null}
    </>
  );
}

/**
 * One row: its line, its disclosure, and the presence rule that belongs to
 * both.
 *
 * Its own component because the hint needs an `id` the GRAB points at and the
 * DISCLOSURE draws, and those are on either side of the line - so the id has to
 * be minted a level above both, which is a hook and therefore not something the
 * list's `map` can do.
 *
 * The row carries the row's identity and nothing operable: the thing with
 * `role="button"` is the NAME inside the line, because a composite widget must
 * not contain the controls it would otherwise name itself from (P-9's trap,
 * R1-02). The focus indicator is on this box rather than on the grab, so what
 * reads as focused is the whole row the keyboard operates (R2-03) - written in
 * `layout-editor.css` beside the grabbed row's lift, which is the file that
 * owns this row's other states (R3-18).
 */
function SortableRow<Id extends string>(props: {
  readonly item: SortableListItem<Id>;
  readonly instructionsId: string | null;
  readonly page: boolean;
  readonly gutter: SortableRowPadding;
  readonly selected: boolean;
  readonly grabbed: boolean;
  readonly onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onBlur: () => void;
}): ReactNode {
  const {
    item,
    instructionsId,
    page,
    gutter,
    selected,
    grabbed,
    onPointerDown,
    onBlur,
  } = props;
  const hintId = useId();
  const open = item.detail !== null && item.open;
  // Built once and placed in one of two ways, because it is ONE description
  // whichever of them the row is showing: the first line of the open
  // disclosure, or a line only a screen reader reaches while it is closed.
  const hint =
    item.hint === null ? null : (
      <SortableRowHint
        id={hintId}
        hint={item.hint}
        open={open}
        page={page}
        padding={gutter.row}
      />
    );
  return (
    <div
      data-sortable-id={item.id}
      data-sortable-selected={selected ? "1" : undefined}
      data-grabbed={grabbed ? "1" : undefined}
      className={cn(
        "relative border-b border-border/40 transition-[background-color,box-shadow] duration-100 ease-out last:border-b-0",
        selected && "bg-foreground/6 shadow-[inset_2px_0_0_var(--ring)]",
      )}
      // On the row rather than on the grab line inside it: a focus leaving
      // anything in this row - the grab line, a control, a control in its
      // expanded detail - is a grab nobody is holding.
      onBlur={onBlur}
    >
      <SortableRowLine
        item={item}
        instructionsId={item.movable ? instructionsId : null}
        hintId={item.hint === null ? null : hintId}
        // A divider and a stack link are joins between members, not members,
        // so both take the hairline's half-height row (LV2-12).
        padding={item.divider || !item.movable ? gutter.divider : gutter.row}
        page={page}
        // A press that selects rather than discloses is a toggle, so it says
        // whether it is on.
        pressed={
          item.detail === null && item.onToggleOpen !== null
            ? selected
            : undefined
        }
        onPointerDown={onPointerDown}
      />
      {open ? (
        <div data-sortable-detail className="border-t border-border/40">
          {hint}
          {item.detail}
        </div>
      ) : (
        hint
      )}
    </div>
  );
}

/**
 * The presence rule (L-47, R3-08).
 *
 * Open, it is the first thing the disclosure says - the row explaining itself
 * on the line the user asked for. Closed, it is still in the document and still
 * the grab's `aria-describedby` target, so the rule reaches a screen reader
 * without the row being opened, and takes no height while it does: a hint that
 * occupied a line only on the rows that have one is what gave one list three
 * row heights (LV2-11).
 */
function SortableRowHint(props: {
  readonly id: string;
  readonly hint: string;
  readonly open: boolean;
  readonly page: boolean;
  /** The row's own gutter, so the line starts in the rows' column. */
  readonly padding: string;
}): ReactNode {
  const { id, hint, open, page, padding } = props;
  if (!open) {
    return (
      <p id={id} className="sr-only">
        {hint}
      </p>
    );
  }
  return (
    <div className={padding}>
      {/* In the label column, under the name it explains, a notch under the
        name's own type scale. */}
      <p
        id={id}
        className={cn(
          "ml-11 max-w-[72ch] text-pretty text-muted-foreground",
          page ? "text-ui-sm" : "text-ui-xs",
        )}
      >
        {hint}
      </p>
    </div>
  );
}

/**
 * The row's one line: what a pointer picks up, what a key operates, and
 * whatever the host hung on the end of it.
 *
 * The line is a plain box and the OPERATION sits on the grab inside it
 * (`role="button"` on the name, the host's controls as its siblings). A
 * `role="button"` computes its accessible name from its contents and must not
 * contain interactive descendants, so a page row that carried its own Shown
 * radios, its Size and its revert read to a screen reader as one collapsed
 * button named "Agents Auto Shown Hidden", with three real controls unreachable
 * as controls (R1-02). Putting the role on the whole line was that defect; the
 * split is what fixes it, and the line keeps the padding so the drag's hit area
 * is still the row rather than the words in it.
 *
 * The chevron stays OUTSIDE the grab, at the end of the line where a disclosure
 * belongs: it is `aria-hidden` decoration, `aria-expanded` is on the grab, and
 * the alternative was drawing it between the name and the controls.
 *
 * The presence rule is outside the grab too, and for the same reason one rung
 * down: a `role="button"` names itself from everything it contains, so the
 * Pull requests row was announced as a button called "Pull requests Auto -
 * appears when this repo has pull requests" (R2-08). It is pointed at by
 * `aria-describedby` beside the grab instructions, which is what a description
 * IS, and it is drawn by the ROW rather than by the line, because it belongs to
 * the disclosure now (R3-08).
 */
function SortableRowLine<Id extends string>(props: {
  readonly item: SortableListItem<Id>;
  /** The static instructions to point at, or `null` in an unordered list. */
  readonly instructionsId: string | null;
  /** The row's presence rule, wherever the row has drawn it, or `null`. */
  readonly hintId: string | null;
  /** The row's own gutter and type scale, decided once by the list. */
  readonly padding: string;
  /** The page host, whose rows alone wrap, and only below `md`. */
  readonly page: boolean;
  /** `aria-pressed` for a row whose press selects it, else `undefined`. */
  readonly pressed: boolean | undefined;
  readonly onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
}): ReactNode {
  const {
    item,
    instructionsId,
    hintId,
    padding,
    page,
    pressed,
    onPointerDown,
  } = props;
  const onRemove = item.onRemove;
  const onStack = item.onStack;
  const described = [instructionsId, hintId]
    .filter((id): id is string => id !== null)
    .join(" ");
  return (
    <div
      data-row-line
      className={cn(
        // One line in both hosts: the name (and its revert) on the left, the
        // control on the right, vertically centred. Only the page below `md`,
        // a phone's one layout surface, drops the control under the name (L-64).
        "flex touch-pan-y items-center gap-2",
        page && "max-md:flex-wrap max-md:gap-y-3",
        item.dimmed && "text-muted-foreground",
        padding,
      )}
      onPointerDown={onPointerDown}
    >
      <div className={rowNameBlockClass(item, page)}>
        <button
          // Every row, not only the ones that open something: a row that can be
          // focused, grabbed and moved has an operation whether or not it also
          // has a destination. Its press is the list's own key and click
          // handling, which is why it has no `onClick`.
          type="button"
          // The selector every host, style and driver finds the row's grab by.
          data-row-grab
          aria-describedby={described === "" ? undefined : described}
          aria-expanded={item.detail === null ? undefined : item.open}
          aria-pressed={pressed}
          className={cn(
            "flex min-w-0 items-center gap-2 text-left focus-visible:outline-none",
            item.divider && "flex-1",
          )}
        >
          {/* The grip's column is kept on rows that cannot move, so every
            row's icon and name start on one line. */}
          {instructionsId === null ? (
            <span aria-hidden className="size-3.5 shrink-0" />
          ) : (
            // The one place a finger picks the row up, so the one place that
            // is `touch-none`. The same 14px slot as every row's spacer; the
            // padding the margin cancels widens its hit area to a fingertip
            // without moving anything.
            <span
              aria-hidden
              data-row-grip
              className="-m-2 box-content flex size-3.5 shrink-0 cursor-grab touch-none p-2"
            >
              <GripVertical className="size-3.5 text-muted-foreground" />
            </span>
          )}
          <SortableRowGlyph item={item} />
          {/* A divider IS a line, so its row draws one where a panel's name
            would keep going: the list reads the way the rail does. */}
          {item.divider ? (
            <>
              <span className="shrink-0 text-muted-foreground">
                {item.label}
              </span>
              <span
                aria-hidden
                data-divider-rule
                className="h-px flex-1 bg-border"
              />
            </>
          ) : (
            <SortableRowName item={item} />
          )}
        </button>
        {/* The revert follows the name it puts back, so the control column
          never moves when a value changes (L-122, LV2-11). */}
        {item.revert === null ? null : (
          <span className="-my-1 flex shrink-0">{item.revert}</span>
        )}
        <SortableStackMembers members={item.stackMembers} />
      </div>
      <div
        className={cn(
          "flex shrink-0 items-center gap-1",
          page && "max-md:ml-auto",
        )}
      >
        {/* The Stack verb (L-168), on the panel ABOVE where the link would
          go, offered only where it can be taken. */}
        {onStack === null ? null : (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Stack ${item.label.toLowerCase()} with the panel below`}
            onClick={(event) => {
              event.stopPropagation();
              onStack();
            }}
          >
            <Rows2 />
          </Button>
        )}
        {item.control}
        {/* A divider's or a stack link's one verb, in the control column. */}
        {onRemove === null ? null : (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={
              item.removeLabel ?? `Remove ${item.label.toLowerCase()}`
            }
            onClick={(event) => {
              event.stopPropagation();
              onRemove();
            }}
          >
            <X />
          </Button>
        )}
      </div>
      {/* The chevron's slot is reserved on every row, so controls share one
        right edge from row to row. */}
      {item.detail === null ? (
        <span aria-hidden className="size-3.5 shrink-0" />
      ) : (
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            item.open && "rotate-90",
          )}
        />
      )}
    </div>
  );
}

/**
 * The row's icon column: a provider's logo where the item carries one, the
 * registry's icon otherwise, and an empty slot of the same size for a row with
 * neither, so every name starts on one line.
 */
function SortableRowGlyph<Id extends string>(props: {
  readonly item: SortableListItem<Id>;
}): ReactNode {
  const { item } = props;
  if (item.glyph !== null) {
    return (
      <span
        aria-hidden
        data-row-glyph
        className={cn(
          "flex size-3.5 shrink-0 items-center justify-center [&>svg]:size-3.5",
          item.dimmed && "opacity-45",
        )}
      >
        {item.glyph}
      </span>
    );
  }
  if (item.icon === null) {
    return <span aria-hidden className="size-3.5 shrink-0" />;
  }
  // Every glyph carries a hook of its own, so a test can name THIS row's icon
  // rather than counting the SVGs in the line and breaking on the next
  // legitimate one (R1-19).
  return (
    <item.icon
      data-row-icon
      className="size-3.5 shrink-0 text-muted-foreground"
    />
  );
}

/**
 * A member's name. A changed row says so with the revert after its name, so it
 * draws no dot of its own; the presence rule is a sibling (R2-08).
 */
function SortableRowName<Id extends string>(props: {
  readonly item: SortableListItem<Id>;
}): ReactNode {
  const { item } = props;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <span
        className={cn(
          "min-w-0 truncate",
          // The stack link is the one row that is not a member: it reads as
          // the quiet join between the two panels around it.
          item.movable ? "font-medium" : "text-muted-foreground",
        )}
      >
        {item.label}
      </span>
    </div>
  );
}

/**
 * The row's name block: its grab, its revert and, on a stack row, the member
 * chips, which wrap under the name when they do not fit its line (L-181).
 */
function rowNameBlockClass<Id extends string>(
  item: SortableListItem<Id>,
  page: boolean,
): string {
  return cn(
    "flex min-w-0 flex-1 items-center gap-1",
    item.stackMembers !== null && "flex-wrap gap-y-1.5",
    page && "max-md:basis-full",
  );
}

/**
 * A stack row's members as chips, each with its own Unstack (L-181), wrapping
 * under the row's name when four do not fit on its line.
 */
function SortableStackMembers(props: {
  readonly members: ReadonlyArray<SortableStackMember> | null;
}): ReactNode {
  if (props.members === null) return null;
  return (
    <ul
      aria-label="Panels in this stack"
      // A line of its own under the row's name, indented past the grip and
      // icon columns to where the name starts (the list's own 44px gutter).
      className="flex min-w-0 basis-full flex-wrap items-center gap-1 pl-11"
    >
      {props.members.map((member) => (
        <li
          key={member.id}
          data-stack-member={member.id}
          className="flex items-center gap-1 rounded-md bg-foreground/5 pl-1.5 text-ui-xs"
        >
          {member.label}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Unstack ${member.label}`}
            onClick={(event) => {
              event.stopPropagation();
              member.onUnstack();
            }}
          >
            <X />
          </Button>
        </li>
      ))}
    </ul>
  );
}

/**
 * A control in the row, which a press or a key on it belongs to rather than to
 * the row. The row's own grab is a `<button>` too, and it IS the row: the grip,
 * the name and a divider's line are all inside it, so a test for any button
 * refused every drag that started where a hand would take hold.
 */
const ROW_CONTROL_SELECTOR = "button:not([data-row-grab])";

/** The row's grip, the only place a touch starts a drag. */
const ROW_GRIP_SELECTOR = "[data-row-grip]";

/** Everything the row's disclosure opened, which the row itself must not claim. */
const DETAIL_SELECTOR = "[data-sortable-detail]";

/** What pressing a row does: open or close its own disclosure in place. */
function activate<Id extends string>(item: SortableListItem<Id>): void {
  item.onToggleOpen?.();
}

function arrowDelta(key: string): number | null {
  if (key === "ArrowUp") return -1;
  if (key === "ArrowDown") return 1;
  return null;
}

/**
 * One keyboard step from `from`: the next index a moving row can land on.
 *
 * A row that cannot move (the rail's stack link) is not a slot of its own: it
 * stands between the two panels it joins, so landing on it would put the
 * moving panel back beside its partner, where it already was, while the list
 * announced a move. The step goes past it instead. No slot that way: `from`.
 */
function stepPastFixed<Id extends string>(
  items: ReadonlyArray<SortableListItem<Id>>,
  from: number,
  delta: number,
): number {
  let to = from + delta;
  while (to >= 0 && to < items.length && !items[to].movable) to += delta;
  return to >= 0 && to < items.length ? to : from;
}

function positionMessage(
  verb: string,
  label: string,
  index: number,
  total: number,
): string {
  return `${verb} ${label}, position ${String(index + 1)} of ${String(total)}.`;
}

function rowsOf(list: HTMLDivElement | null): ReadonlyArray<HTMLElement> {
  if (list === null) return [];
  return [...list.querySelectorAll<HTMLElement>("[data-sortable-id]")];
}
