import {
  memo,
  useCallback,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Link } from "@tanstack/react-router";
import { Check, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import {
  canDeleteHistoryItem,
  canEditHistoryItemTitle,
  type HistoryItem,
} from "@/components/home/data/home-page.data";
import { HistoryRowLeadingIcon } from "@/components/epics/epics-list-shared";
import { historyItemDisplayTitle } from "@/components/epics/history-item-title";
import {
  TRAY_ACTION_PX,
  useRowSwipeTray,
} from "@/components/epics/mobile/use-row-swipe-tray";
import { useLongPress } from "@/hooks/ui/use-long-press";
import { useEpicUpdateTitle } from "@/hooks/epic/use-epic-title-mutation";
import {
  useInlineRename,
  type InlineRenameInputProps,
} from "@/hooks/ui/use-inline-rename";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { cn } from "@/lib/utils";

/**
 * How long the row takes to settle back to - or out to - its resting offset
 * once the finger is gone. Matches the shell drawer's settle so the two
 * horizontal motions in the app read as the same material.
 *
 * A class rather than an inline style, and that is load-bearing: `press-scrim`
 * lands its tint by zeroing `transition-duration` under `:active`, and an
 * inline duration would outrank it and stretch the press tint over the settle.
 */
const SETTLE_CLASS = "transition-transform duration-[220ms]";

type TrayActionKind = "pin" | "rename" | "delete";

interface TrayAction {
  readonly kind: TrayActionKind;
  readonly label: string;
  readonly icon: ReactNode;
  readonly destructive: boolean;
  readonly run: () => void;
}

export interface MobileHistoryRowProps {
  readonly item: HistoryItem;
  readonly selectionMode: boolean;
  readonly isSelected: boolean;
  readonly isTrayOpen: boolean;
  readonly isPinPending: boolean;
  readonly onTrayOpenChange: (epicId: string, open: boolean) => void;
  readonly onToggleSelection: (id: string) => void;
  readonly onRequestDelete: (ids: ReadonlyArray<string>) => void;
  readonly onSetPinned: (epicId: string, pinned: boolean) => void;
  readonly onOpen: (item: HistoryItem) => void;
}

/**
 * One task in the phone list: title, when it was last touched, and nothing
 * else at rest.
 *
 * The row carries three touch gestures and they are deliberately layered so
 * only one can ever win. A tap opens the task. A swipe left reveals the action
 * tray - never committing on its own, because delete lives in there. A
 * press-and-hold enters selection mode, the same mode the toolbar's Select
 * button opens, with this row already checked.
 *
 * The recognizers cancel each other rather than vote: the swipe cancels a
 * pending hold the moment it declares an axis, and either one having fired
 * swallows the click the browser synthesises afterwards. Without that swallow
 * a long press would select the row AND open it.
 */
export const MobileHistoryRow = memo(function MobileHistoryRow(
  props: MobileHistoryRowProps,
): ReactNode {
  const {
    item,
    selectionMode,
    isSelected,
    isTrayOpen,
    isPinPending,
    onTrayOpenChange,
    onToggleSelection,
    onRequestDelete,
    onSetPinned,
    onOpen,
  } = props;

  const displayTitle = historyItemDisplayTitle(item);
  const canDelete = canDeleteHistoryItem(item);
  const canRename = canEditHistoryItemTitle(item);
  // Phases carry no pin bit of their own - they are reached through the epic
  // that owns them - so pinning is an epic-only affordance.
  const canPin = item.taskType === "epic";
  const isPhase = item.taskType === "phase";
  const linkTabId = useEpicCanvasStore(
    (s) => s.resolveTabIdForEpic(item.epicId) ?? item.epicId,
  );

  const { mutate: renameEpicTitle, isPending: isRenamePending } =
    useEpicUpdateTitle();
  const commitTitle = useCallback(
    (nextTitle: string) => {
      renameEpicTitle({
        epicDelta: { id: item.epicId, title: nextTitle, updatedAt: Date.now() },
      });
    },
    [item.epicId, renameEpicTitle],
  );
  const {
    isEditing: isRenaming,
    startEditing: startRenaming,
    inputProps: renameInputProps,
  } = useInlineRename({
    value: item.title,
    canEdit: canRename && !isRenamePending,
    onCommit: commitTitle,
  });

  const setTrayOpen = useCallback(
    (open: boolean) => {
      onTrayOpenChange(item.epicId, open);
    },
    [item.epicId, onTrayOpenChange],
  );

  const isRowSelected = selectionMode && isSelected && canDelete;

  const actions = buildTrayActions({
    item,
    displayTitle,
    canPin,
    canRename,
    canDelete,
    isPinPending,
    onSetPinned,
    onRequestDelete,
    onStartRename: startRenaming,
  });

  // Selection mode and the tray are mutually exclusive. The toolbar owns every
  // action there, so a row-level pin/rename/delete would be a second, quieter
  // way to act on one row in the middle of a bulk operation.
  //
  // Not merely hidden - UNMOUNTED. Nothing conceals the tray at rest except the
  // card's background, so a mounted tray leaves every future card state one
  // lost opacity away from putting a row's own actions on screen in a mode
  // that cannot use them.
  const showTray = !selectionMode && actions.length > 0;
  const isTrayRevealed = isTrayOpen && showTray;

  const longPress = useLongPress({
    // A row nobody may act on has nothing to select, so the hold would open a
    // mode with a permanently unchecked row in it.
    disabled: selectionMode || isRenaming || !canDelete,
    onLongPress: () => {
      setTrayOpen(false);
      onToggleSelection(item.epicId);
    },
  });
  const swipe = useRowSwipeTray({
    actionCount: actions.length,
    isOpen: isTrayOpen,
    onOpenChange: setTrayOpen,
    disabled: selectionMode || isRenaming,
    onDragStart: longPress.cancel,
  });

  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    longPress.handlers.onPointerDown(event);
    swipe.handlers.onPointerDown(event);
  };
  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    longPress.handlers.onPointerMove(event);
    swipe.handlers.onPointerMove(event);
  };
  const handlePointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    longPress.handlers.onPointerUp(event);
    swipe.handlers.onPointerUp(event);
  };
  const handlePointerCancel = (event: ReactPointerEvent<HTMLElement>) => {
    longPress.handlers.onPointerCancel(event);
    swipe.handlers.onPointerCancel(event);
  };

  // The gutter checkbox and the card's overlay are disjoint subtrees - neither
  // contains the other - so a tap lands on exactly one of them and there is no
  // bubbling path that could toggle twice. They are also only ever the SAME
  // action: the overlay is a plain button in selection mode, never the router
  // Link, so "open" is unreachable from either while the mode is on.
  const handleToggleSelection = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    if (!canDelete) return;
    onToggleSelection(item.epicId);
  };

  // Bound to the overlay ITSELF, never to an ancestor. The overlay is a router
  // Link, and the router runs its own click handler on the anchor and
  // navigates from it - by the time a click reached a handler on the card it
  // would already have gone somewhere, taking the Phase migration route, the
  // tray-dismiss tap and the selection toggle with it. A handler supplied to
  // the Link runs first and `preventDefault()` here is what stands the router
  // down.
  const handleActivate = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    if (longPress.consumedTap() || swipe.consumedTap()) return;
    if (selectionMode) {
      handleToggleSelection(event);
      return;
    }
    // While the tray is out the row itself is the way back: tapping it puts
    // the actions away rather than navigating past them.
    if (isTrayOpen) {
      swipe.close();
      return;
    }
    onOpen(item);
  };

  return (
    <li
      data-testid="epics-list-row"
      data-pinned={item.isPinned}
      // Where the tray exists at all it stays mounted while closed, so
      // "revealed" is a state rather than a presence. In selection mode it
      // does not exist, and this attribute is absent for that reason instead.
      data-tray-open={isTrayRevealed ? "true" : undefined}
      className="flex items-stretch gap-2"
    >
      {selectionMode ? (
        <RowSelectionCheckbox
          displayTitle={displayTitle}
          isChecked={isRowSelected}
          canDelete={canDelete}
          onToggle={handleToggleSelection}
        />
      ) : null}
      {/* The clip is what makes the tray a reveal rather than a second row:
          it sits underneath at full height and is only ever seen through the
          gap the card leaves as it slides. */}
      <div className="relative min-w-0 flex-1 overflow-hidden rounded-md">
        {showTray ? (
          <RowActionTray
            actions={actions}
            widthPx={swipe.trayWidthPx}
            onReveal={setTrayOpen}
            onRun={swipe.close}
          />
        ) : null}
        <div
          data-testid="epics-list-row-card"
          // `pan-y` hands the vertical axis back to the list and keeps the
          // horizontal one here, which is what lets the swipe recognizer read
          // the drag without ever cancelling a scroll.
          className={mobileRowCardClassName({
            isRowSelected,
            isDragging: swipe.isDragging,
          })}
          style={{ transform: `translate3d(-${swipe.offsetPx}px, 0, 0)` }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
        >
          <RowActivationOverlay
            item={item}
            displayTitle={displayTitle}
            isPhase={isPhase}
            linkTabId={linkTabId}
            selectionMode={selectionMode}
            isRenaming={isRenaming}
            onActivate={handleActivate}
          />
          {/* Everything the row paints is inert, so the overlay is the only
              thing a touch can land on and activation has exactly one path.
              The pointer handlers above still see the gesture - pointer events
              reach the card by bubbling, which is not where the problem was. */}
          <span className="pointer-events-none flex shrink-0 items-center">
            <HistoryRowLeadingIcon item={item} />
          </span>
          <RowTitleBlock
            displayTitle={displayTitle}
            updatedLabel={item.updatedLabel}
            isPinned={item.isPinned}
            isRenaming={isRenaming}
            renameInputProps={renameInputProps}
          />
        </div>
      </div>
    </li>
  );
});

/**
 * The card's own classes, kept out of the row body the way the desktop list
 * keeps its equivalent.
 *
 * The background is load-bearing: it is the only thing concealing the tray
 * parked behind the card, so whatever wins here has to be OPAQUE. A selected
 * row therefore gets the accent pre-mixed against this same backdrop rather
 * than `bg-accent/40`, which is the same 40% blend taken against transparency.
 * Over this card the two read alike, but only this one stays solid, so `cn()`
 * displacing the base is harmless instead of see-through. `oklch` matches the
 * colour space `index.css` already mixes in.
 *
 * `pan-y` hands the vertical axis back to the list and keeps the horizontal
 * one for the swipe recognizer, which is what lets it read a drag without ever
 * cancelling a scroll.
 */
function mobileRowCardClassName(args: {
  readonly isRowSelected: boolean;
  readonly isDragging: boolean;
}): string {
  return cn(
    "relative flex touch-pan-y items-center gap-2 rounded-md bg-background p-3 text-ui-sm",
    "active:press-scrim pointer-coarse:touch-chrome",
    args.isRowSelected &&
      "bg-[color-mix(in_oklch,var(--accent)_40%,var(--background))] ring-1 ring-inset ring-primary/40",
    !args.isDragging && SETTLE_CLASS,
  );
}

/**
 * The row's label: its title over when it was last touched, or the field that
 * renames it. Inert to pointers - the activation overlay above is the only
 * thing a touch lands on - except while renaming, when the field is the point.
 */
function RowTitleBlock(props: {
  readonly displayTitle: string;
  readonly updatedLabel: string;
  readonly isPinned: boolean;
  readonly isRenaming: boolean;
  readonly renameInputProps: InlineRenameInputProps;
}): ReactNode {
  if (props.isRenaming) {
    return (
      <input
        {...props.renameInputProps}
        type="text"
        aria-label={`Rename ${props.displayTitle}`}
        data-testid="epics-list-row-title-input"
        className="w-full min-w-0 flex-1 rounded border border-input bg-background/90 px-1.5 py-0.5 font-medium text-foreground outline-none focus:border-ring/70 focus-visible:ring-0"
      />
    );
  }
  return (
    <span className="pointer-events-none flex min-w-0 flex-1 flex-col gap-0.5 overflow-hidden">
      <span className="flex min-w-0 items-center gap-1.5">
        {props.isPinned ? (
          // State, not an action: pinning is a tray action, and without this
          // marker the sort order would be the only evidence it took effect.
          <Pin
            className="size-3 shrink-0 fill-current text-primary"
            data-testid="epics-list-row-pinned"
            role="img"
            aria-label="Pinned"
          />
        ) : null}
        <span className="truncate font-medium text-foreground">
          {props.displayTitle}
        </span>
      </span>
      <span className="truncate text-ui-xs text-muted-foreground">
        updated {props.updatedLabel}
      </span>
    </span>
  );
}

/**
 * The focusable, addressable surface over the row.
 *
 * A link rather than a bare click target so the row has a real destination -
 * focus ring, assistive-technology role, and a URL. It is also the ONLY thing
 * in the row a touch can land on: the card's contents are inert, so there is
 * one activation path rather than a race between this and an ancestor. In
 * selection mode it is a button instead, because a link that never goes
 * anywhere would announce a destination the tap does not take.
 */
function RowActivationOverlay(props: {
  readonly item: HistoryItem;
  readonly displayTitle: string;
  readonly isPhase: boolean;
  readonly linkTabId: string;
  readonly selectionMode: boolean;
  readonly isRenaming: boolean;
  readonly onActivate: (event: ReactMouseEvent<HTMLElement>) => void;
}): ReactNode {
  // An inline rename puts a real text field where the title was; an overlay
  // covering it would take every tap meant for the caret.
  if (props.isRenaming) return null;
  const overlayClassName =
    "absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50";
  if (props.selectionMode) {
    return (
      <button
        type="button"
        aria-label={`Toggle selection for ${props.displayTitle}`}
        className={overlayClassName}
        onClick={props.onActivate}
      />
    );
  }
  return (
    <Link
      to="/epics/$epicId/$tabId"
      params={{ epicId: props.item.epicId, tabId: props.linkTabId }}
      search={{
        focusedAt: undefined,
        focusArtifactId: undefined,
        focusThreadId: undefined,
        migrationSource: props.isPhase ? "phase" : undefined,
        focusPaneId: undefined,
        focusTileInstanceId: undefined,
      }}
      onClick={props.onActivate}
      aria-label={`Open task ${props.displayTitle}`}
      className={overlayClassName}
    />
  );
}

/**
 * The row's place in a bulk selection.
 *
 * A full touch target rather than the 16px box it draws, with the box as an
 * inert child - the whole gutter is the control. Rows shifting right on
 * entering the mode is the platform's own behaviour and reads as the mode
 * announcing itself.
 */
function RowSelectionCheckbox(props: {
  readonly displayTitle: string;
  readonly isChecked: boolean;
  readonly canDelete: boolean;
  readonly onToggle: (event: ReactMouseEvent<HTMLElement>) => void;
}): ReactNode {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={props.isChecked}
      aria-disabled={!props.canDelete}
      aria-label={`Select ${props.displayTitle}`}
      data-testid="epics-list-row-select"
      className={cn(
        "flex size-11 shrink-0 self-center items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        // An `aria-disabled` control still matches `:active`, so the press has
        // to be suppressed explicitly or the row tints for a tap that does
        // nothing.
        props.canDelete ? "active:press-scrim" : "cursor-not-allowed",
      )}
      onClick={props.onToggle}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex size-4 items-center justify-center rounded-sm border transition-colors",
          props.canDelete ? "opacity-100" : "opacity-50",
          props.isChecked
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-background text-transparent",
        )}
      >
        <Check className="size-3" />
      </span>
    </button>
  );
}

/**
 * The actions parked behind the row, seen only through the gap the card leaves
 * as it slides. Sized from its actions rather than measured, because the reveal
 * distance has to be known on the first move of a drag.
 */
function RowActionTray(props: {
  readonly actions: ReadonlyArray<TrayAction>;
  readonly widthPx: number;
  readonly onReveal: (open: boolean) => void;
  readonly onRun: () => void;
}): ReactNode {
  return (
    <div
      className="absolute inset-y-0 right-0 flex items-stretch"
      style={{ width: `${props.widthPx}px` }}
      data-testid="epics-list-row-tray"
      // Mounted while closed so it keeps its place in the tab order; a keyboard
      // reaching it opens it, because a caret on a clipped control is a dead
      // end.
      onFocus={() => {
        props.onReveal(true);
      }}
    >
      {props.actions.map((action) => (
        <button
          key={action.kind}
          type="button"
          aria-label={action.label}
          data-testid={`epics-list-row-tray-${action.kind}`}
          style={{ width: `${TRAY_ACTION_PX}px` }}
          className={cn(
            "flex shrink-0 items-center justify-center outline-none active:press-scrim focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50",
            action.destructive
              ? "bg-destructive/15 text-destructive"
              : "bg-muted text-muted-foreground",
          )}
          onClick={() => {
            props.onRun();
            action.run();
          }}
        >
          {action.icon}
        </button>
      ))}
    </div>
  );
}

function buildTrayActions(args: {
  readonly item: HistoryItem;
  readonly displayTitle: string;
  readonly canPin: boolean;
  readonly canRename: boolean;
  readonly canDelete: boolean;
  readonly isPinPending: boolean;
  readonly onSetPinned: (epicId: string, pinned: boolean) => void;
  readonly onRequestDelete: (ids: ReadonlyArray<string>) => void;
  readonly onStartRename: () => void;
}): ReadonlyArray<TrayAction> {
  const { item, displayTitle } = args;
  const actions: TrayAction[] = [];
  if (args.canPin) {
    actions.push({
      kind: "pin",
      label: item.isPinned
        ? `Unpin ${displayTitle} from top`
        : `Pin ${displayTitle} to top`,
      icon: item.isPinned ? (
        <PinOff className="size-4" />
      ) : (
        <Pin className="size-4" />
      ),
      destructive: false,
      run: () => {
        // The pin flips optimistically, so a second tap landing inside the
        // mutation's window would toggle it straight back.
        if (args.isPinPending) return;
        args.onSetPinned(item.epicId, !item.isPinned);
      },
    });
  }
  if (args.canRename) {
    actions.push({
      kind: "rename",
      label: `Rename ${displayTitle}`,
      icon: <Pencil className="size-4" />,
      destructive: false,
      // Inline, exactly as the desktop row renames: the input lands where the
      // row already is, so the keyboard pushes the list rather than covering a
      // centred dialog.
      run: args.onStartRename,
    });
  }
  if (args.canDelete) {
    actions.push({
      kind: "delete",
      label: `Delete ${displayTitle}`,
      icon: <Trash2 className="size-4" />,
      destructive: true,
      // Opens the shared confirm dialog rather than deleting here. A swipe is
      // a cheap gesture and this is the one irreversible thing a row can do.
      run: () => {
        args.onRequestDelete([item.epicId]);
      },
    });
  }
  return actions;
}
