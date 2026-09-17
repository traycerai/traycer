import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { LayersPlus } from "lucide-react";
import { useStore } from "zustand";

import type { ComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import {
  DRAFT_ROW_SELECTOR,
  DraftRow,
} from "@/components/composer/drafts/draft-row";
import { DraftsFilterToggle } from "@/components/composer/drafts/drafts-filter-toggle";
import { Button } from "@/components/ui/button";
import { Command, CommandGroup, CommandList } from "@/components/ui/command";
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  useDraftInventory,
  useDraftInventoryCount,
} from "@/hooks/drafts/use-draft-inventory";
import { useDraftInventoryActions } from "@/hooks/drafts/use-draft-inventory-actions";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { registerActiveDraftsControl } from "@/lib/commands/active-drafts-control-registry";
import {
  draftRowSourceChip,
  type DraftInventoryFilter,
  type DraftInventoryRow,
  type DraftInventoryScope,
} from "@/lib/drafts/draft-inventory";
import { useBareKeyClaimer } from "@/lib/keybindings/use-bare-key-claimer";
import { cn } from "@/lib/utils";

export interface ComposerDraftsControlProps {
  readonly scope: DraftInventoryScope;
  /** The SURFACE's host - what a start-page row is deleted through. */
  readonly hostId: string | null;
  readonly pickerStore: ComposerPickerStore;
  readonly editorRef: RefObject<ComposerPromptEditorHandle | null>;
  /**
   * Whether this surface owns `Cmd+S` right now. The registry is a stack, so
   * an overlay composer (the new-agent modal) registers over the surface
   * beneath it and hands the chord back when it closes - which is why the
   * modal passes `true` for its whole open lifetime rather than tracking its
   * own mode.
   */
  readonly active: boolean;
}

/**
 * Force-close is one-directional: the signal going away never reopens the
 * control, so calling this every render costs nothing once `open` is already
 * `false`. Shared by the picker and surface-inactive closes below so the
 * render-phase adjustment (React's documented "adjusting state when a prop
 * changes" pattern, not `react-hooks/set-state-in-effect`'s forbidden
 * synchronous-effect setState) only has to be written once.
 */
function closeIfOpen(
  open: boolean,
  shouldClose: boolean,
  setOpenState: (open: boolean) => void,
): void {
  if (shouldClose && open) setOpenState(false);
}

function ComposerDraftsControlImpl(props: ComposerDraftsControlProps) {
  const { scope, hostId, pickerStore, editorRef, active } = props;
  const mobile = useIsMobileViewport();
  const [open, setOpenState] = useState(false);
  const [filter, setFilter] = useState<DraftInventoryFilter>("current");
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const restoreEditorFocusRef = useRef(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const pickerOpen = useStore(pickerStore, (state) => state.open);

  const rows = useDraftInventory(scope, filter);
  // D18: the badge counts what the CURRENT-surface filter would show, whatever
  // the open list is currently filtered to.
  const currentCount = useDraftInventoryCount(scope, "current");
  const { openRow, copyRow, deleteRow } = useDraftInventoryActions(hostId);

  const scopeEpicId = scope.surface === "landing" ? null : scope.epicId;
  const selectedId = resolveSelectedId(rows, highlightedId);
  const selectedRow = rows.find((row) => row.id === selectedId);

  const setOpen = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        restoreEditorFocusRef.current = editorRef.current?.hasFocus() ?? false;
        // D05: the filter is not a preference. Every open starts on the
        // surface that asked.
        setFilter("current");
        setHighlightedId(null);
      }
      setOpenState(nextOpen);
    },
    [editorRef],
  );

  const focusEditor = useCallback(() => {
    editorRef.current?.focus();
  }, [editorRef]);

  // `Cmd+S` toggles rather than opens: the action stays in
  // `REPEAT_SENSITIVE_ACTIONS` precisely because it is a toggle, and a second
  // press of a chord that put a list on screen should take it back off. The
  // open state rides behind a ref so the registration's identity does not move
  // with it - re-registering would jump this surface above an overlay that
  // legitimately owns the chord.
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  const toggleOpen = useCallback(() => {
    setOpen(!openRef.current);
  }, [setOpen]);
  useEffect(() => {
    if (!active) return;
    return registerActiveDraftsControl(toggleOpen);
  }, [active, toggleOpen]);

  // The picker popover and this one anchor to the same composer card; only one
  // of them can own the keyboard.
  closeIfOpen(open, pickerOpen, setOpenState);

  const scrollRowIntoView = useCallback((rowId: string) => {
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
    }
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const elements =
        listRef.current?.querySelectorAll<HTMLElement>(DRAFT_ROW_SELECTOR) ??
        [];
      const element = Array.from(elements).find(
        (candidate) => candidate.dataset.draftRowId === rowId,
      );
      element?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }, []);
  useEffect(
    () => () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
    },
    [],
  );

  const handleOpenRow = useCallback(
    (row: DraftInventoryRow) => {
      restoreEditorFocusRef.current = false;
      setOpenState(false);
      openRow(row);
    },
    [openRow],
  );
  // Delete keeps the list open on the NEXT row (the deleted one is about to
  // leave the projection), so a run of deletions needs one keystroke each.
  const handleDeleteRow = useCallback(
    (row: DraftInventoryRow) => {
      setHighlightedId(neighbourRowId(rows, row.id));
      deleteRow(row);
    },
    [deleteRow, rows],
  );

  const claimCopyKey = useBareKeyClaimer("c", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (selectedRow === undefined) return;
    copyRow(selectedRow);
  });
  const claimDeleteKey = useBareKeyClaimer("d", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (selectedRow === undefined) return;
    handleDeleteRow(selectedRow);
  });
  const rowHighlighted = selectedRow !== undefined;
  // `active` is the SURFACE's own focus, and it gates the keys as well as the
  // chord. `PopoverContent` un-presents its portal when the pane loses focus
  // or is concealed while leaving the root open (`usePaneAwareContentGuard`),
  // so a pane switch with the list open otherwise leaves an INVISIBLE control
  // still eating arrows, Tab and Enter and still holding `c`/`d` - and `d`
  // deletes a draft while the user is typing in the pane they moved to.
  const keysActive = open && active && !mobile && rowHighlighted;
  useEffect(
    () => (keysActive ? claimCopyKey() : undefined),
    [claimCopyKey, keysActive],
  );
  useEffect(
    () => (keysActive ? claimDeleteKey() : undefined),
    [claimDeleteKey, keysActive],
  );
  // Closing is the other half: a list the user cannot see must not still be
  // open when they come back to this surface, and the gates above only stop
  // it acting. `setOpenState`, not `setOpen` - there is no editor here to
  // hand focus back to.
  closeIfOpen(open, !active, setOpenState);

  useEffect(() => {
    if (!open || !active || mobile) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        setFilter((current) => (current === "current" ? "all" : "current"));
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (rows.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        const nextRow = rows.at(
          nextRowIndex(
            rows.findIndex((row) => row.id === selectedId),
            event.key === "ArrowDown" ? "down" : "up",
            rows.length,
          ),
        );
        if (nextRow === undefined) return;
        setHighlightedId(nextRow.id);
        scrollRowIntoView(nextRow.id);
        return;
      }
      if (isPlainPrintableKeydown(event)) {
        // Not consumed and not prevented: the claimer's own window listener
        // runs in the bubble phase and answers it.
        if (isClaimedRowLetter(event, rowHighlighted)) return;
        setOpen(false);
        return;
      }
      if (event.key === "Enter") {
        // Consumed whether or not a row is highlighted. The popover keeps
        // editor focus on purpose, so an Enter that fell through would SUBMIT
        // the composer behind it - and the two states where nothing is
        // highlighted are ordinary ones: the list opens with zero rows, and it
        // stays open after the last row is deleted.
        event.preventDefault();
        event.stopPropagation();
        if (selectedRow === undefined) return;
        handleOpenRow(selectedRow);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    active,
    handleOpenRow,
    mobile,
    open,
    rowHighlighted,
    rows,
    scrollRowIntoView,
    selectedId,
    selectedRow,
    setOpen,
  ]);

  const list = (
    <Command
      loop
      value={selectedId ?? ""}
      onValueChange={setHighlightedId}
      className="max-h-full min-h-0 rounded-lg bg-transparent p-0"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-2.5 py-1.5">
        <span className="text-ui-xs font-medium tracking-wide text-muted-foreground uppercase">
          Drafts
        </span>
        <DraftsFilterToggle
          value={filter}
          currentLabel={
            scope.surface === "landing" ? "Start page" : "This epic"
          }
          onChange={setFilter}
        />
      </div>
      <CommandList ref={listRef} className="max-h-none min-h-0">
        {rows.length === 0 ? (
          <p className="px-2.5 py-6 text-center text-ui-sm text-muted-foreground">
            {filter === "current" ? "No drafts here yet" : "No drafts"}
          </p>
        ) : (
          <CommandGroup className="p-1">
            {rows.map((row) => (
              <DraftRow
                key={row.id}
                row={row}
                sourceChip={draftRowSourceChip(row, scopeEpicId, filter)}
                mobile={mobile}
                onHighlight={() => setHighlightedId(row.id)}
                onOpen={() => handleOpenRow(row)}
                onCopy={() => copyRow(row)}
                onDelete={() => handleDeleteRow(row)}
              />
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </Command>
  );

  // A `Button` ELEMENT, not a wrapper component: `asChild` merges the
  // trigger's props (including its ref and `onClick`) onto whatever element it
  // is given, and a component that does not spread them would swallow them.
  const trigger = (
    <Button
      type="button"
      variant="outline"
      size="xs"
      aria-label={draftsTriggerLabel(currentCount)}
      className={cn(
        "rounded-full bg-background/95 px-2.5 text-muted-foreground shadow-sm hover:text-foreground",
        open && "text-foreground",
      )}
      // Desktop keeps the editor focused behind the open list; vaul needs the
      // pointer sequence it would otherwise lose (critique G6).
      onPointerDown={mobile ? undefined : (event) => event.preventDefault()}
    >
      <LayersPlus className="size-3.5" aria-hidden />
      <span>Drafts</span>
      {currentCount === 0 ? null : (
        <span className="rounded-full bg-foreground/8 px-1.5 font-medium tabular-nums">
          {currentCount}
        </span>
      )}
    </Button>
  );

  if (mobile) {
    return (
      <Drawer open={open} onOpenChange={setOpen} direction="bottom">
        <DraftsTriggerRail>
          <DrawerTrigger asChild>{trigger}</DrawerTrigger>
        </DraftsTriggerRail>
        {/* A drawer is portalled and `fixed`, so `#root`'s reservation never
            reaches it, and the edge it is anchored to is the one it has to pad
            itself: without this the last row's tap targets sit under the home
            indicator. */}
        <DrawerContent className="max-h-[min(80dvh,40rem)] gap-0 overflow-hidden p-0 pb-safe-bottom">
          <DrawerTitle className="sr-only">Drafts</DrawerTitle>
          {list}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <DraftsTriggerRail>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      </DraftsTriggerRail>
      {open ? (
        <PopoverContent
          side="top"
          align="end"
          sideOffset={6}
          className="max-h-[min(70dvh,var(--radix-popover-content-available-height))] w-[calc(100vw-2rem)] max-w-lg gap-0 overflow-hidden p-0"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const shouldRestore = restoreEditorFocusRef.current;
            restoreEditorFocusRef.current = false;
            if (shouldRestore) focusEditor();
          }}
        >
          {list}
        </PopoverContent>
      ) : null}
    </Popover>
  );
}

function DraftsTriggerRail(props: { readonly children: ReactNode }) {
  return (
    <div data-composer-utility-rail="" className="relative shrink-0">
      {props.children}
    </div>
  );
}

function draftsTriggerLabel(count: number): string {
  if (count === 0) return "Drafts";
  return `Drafts: ${String(count)}. Open drafts.`;
}

/**
 * The highlight, falling back to the first row. A highlight that no longer
 * names a listed row (its draft was deleted, or the filter moved) is dropped
 * rather than left pointing at nothing.
 */
function resolveSelectedId(
  rows: ReadonlyArray<DraftInventoryRow>,
  highlightedId: string | null,
): string | null {
  if (highlightedId !== null && rows.some((row) => row.id === highlightedId)) {
    return highlightedId;
  }
  return rows.at(0)?.id ?? null;
}

/** The row a deletion should leave highlighted: the next one, else the previous. */
function neighbourRowId(
  rows: ReadonlyArray<DraftInventoryRow>,
  deletedId: string,
): string | null {
  const index = rows.findIndex((row) => row.id === deletedId);
  if (index === -1) return null;
  return rows.at(index + 1)?.id ?? rows.at(index - 1)?.id ?? null;
}

function nextRowIndex(
  currentIndex: number,
  direction: "up" | "down",
  length: number,
): number {
  const offset = direction === "down" ? 1 : -1;
  const fallbackIndex = offset === 1 ? -1 : 0;
  return (
    ((currentIndex < 0 ? fallbackIndex : currentIndex) + offset + length) %
    length
  );
}

function isPlainPrintableKeydown(event: KeyboardEvent): boolean {
  return (
    event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey
  );
}

/**
 * The letters the open list owns while a row is highlighted. Everything else
 * printable closes the list and reaches the still-focused editor, which is how
 * the prompt stash behaved and why typing never got trapped behind it.
 * `useBareKeyClaimer` arbitrates WHO answers a claimed letter; this predicate
 * is what stops the close-on-printable branch from firing first (critique D6),
 * which is precisely the bug a hardcoded `d` left in the stash.
 *
 * Read from `key`, not `code`, on purpose: these are accelerators on the
 * VISIBLE labels beside each row, so the character the reader's layout
 * produces is the request. `chord-matchers-derive-from-code.test.ts` inventories
 * the pair for that reason - keep the comparisons literal so it can see them.
 */
function isClaimedRowLetter(
  event: KeyboardEvent,
  rowHighlighted: boolean,
): boolean {
  if (!rowHighlighted || event.shiftKey) return false;
  return event.key.toLowerCase() === "c" || event.key.toLowerCase() === "d";
}

export const ComposerDraftsControl = memo(ComposerDraftsControlImpl);
