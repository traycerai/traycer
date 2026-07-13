import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Laptop,
  Lock,
  Search,
  Split,
} from "lucide-react";
import type { WorktreeFolderIntent } from "@traycer/protocol/host/worktree-schemas";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import {
  worktreeImportRows,
  type UnifiedPickerWorktreeRow,
} from "@/components/home/worktree/worktree-unified-picker-model";
import { workspaceFolderName } from "@/lib/worktree/workspace-folder-name";
import { cn } from "@/lib/utils";
import {
  FOLDER_CONTROL_TRIGGER_CLASS,
  folderLocationValue,
  type FolderLocationValue,
  type WorkspaceRunItem,
} from "./workspace-run-item";
import { promotePickerRow } from "./promote-picker-row";

// Above this many on-disk worktrees the submenu shows a search bar; the list is
// always height-capped to ~5 rows and scrolls beyond that.
const EXISTING_WORKTREE_SEARCH_THRESHOLD = 5;
const NON_GIT_LOCATION_DISABLED_REASON =
  "Worktrees require a Git repository. This folder can only run Local.";

function locationLabel(value: FolderLocationValue): string {
  if (value === "local") return "Local";
  if (value === "worktree") return "New worktree";
  return "Existing worktree";
}

function LocationGlyph(props: { readonly value: FolderLocationValue }) {
  // Leading icons stay muted regardless of `--fc-text` (which only brightens the
  // label text), matching the host rows' muted kind icon + bright label.
  if (props.value === "local") {
    return (
      <Laptop
        className="size-3.5 shrink-0 text-muted-foreground/65"
        aria-hidden
      />
    );
  }
  // New + existing worktrees share the rotated split glyph.
  return (
    <Split
      className="size-3.5 shrink-0 rotate-90 text-muted-foreground/65"
      aria-hidden
    />
  );
}

/**
 * The per-row Location control: a dropdown with Local / New worktree / Existing
 * worktree. Existing worktree opens a submenu of on-disk worktrees built from
 * the summary alone (no `listBranches`); one click adopts it (→ `import`). The
 * value is derived from `currentIntent.kind ?? mode`. Disabled (with the rebind
 * tooltip) when `item.modeDisabled`. A non-git folder offers Local only.
 */
export function FolderLocationControl(props: {
  readonly item: WorkspaceRunItem;
  /** Host-wide uncommitted counts keyed by worktree path (optional annotation). */
  readonly uncommittedByPath: ReadonlyMap<string, number>;
  /** Collision boundary for the menu (in-epic rows live in a popover). */
  readonly boundaryEl: HTMLElement | null;
  readonly readOnly: boolean;
}) {
  const { item } = props;
  const value = folderLocationValue(item);
  const triggerDisabled = item.modeDisabled || !item.isGitRepo;
  const triggerDisabledReason = item.modeDisabled
    ? item.modeDisabledReason
    : NON_GIT_LOCATION_DISABLED_REASON;
  const importRows = useMemo(
    () =>
      item.summary === null
        ? []
        : worktreeImportRows({
            workspacePath: item.displayPath,
            repoIdentifier: item.repoIdentifier,
            isPrimary: item.isPrimary,
            summary: item.summary,
            currentIntent: item.currentIntent,
          }),
    [
      item.summary,
      item.displayPath,
      item.repoIdentifier,
      item.isPrimary,
      item.currentIntent,
    ],
  );

  const trigger = (
    <button
      type="button"
      disabled={item.modeDisabled}
      aria-disabled={props.readOnly || triggerDisabled ? true : undefined}
      aria-label="Choose run location"
      data-testid="folder-location-trigger"
      className={cn(FOLDER_CONTROL_TRIGGER_CLASS)}
    >
      <LocationGlyph value={value} />
      {/* Reserve the widest label's width with an invisible ghost so the control
          is static across mode switches AND snug to the longest label — no empty
          space trailing "Existing worktree". */}
      <span className="grid min-w-0 flex-1 text-left">
        <span
          aria-hidden
          className="invisible col-start-1 row-start-1 truncate"
        >
          {locationLabel("import")}
        </span>
        <span className="col-start-1 row-start-1 truncate">
          {locationLabel(value)}
        </span>
      </span>
      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground/60" />
    </button>
  );

  if (triggerDisabled) {
    const disabledTrigger = item.modeDisabled ? (
      <span className="inline-flex min-w-0">{trigger}</span>
    ) : (
      trigger
    );
    if (triggerDisabledReason === null) return disabledTrigger;
    return (
      <TooltipWrapper
        label={triggerDisabledReason}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        {disabledTrigger}
      </TooltipWrapper>
    );
  }

  if (props.readOnly) {
    return trigger;
  }

  return (
    <FolderLocationMenu
      item={item}
      value={value}
      trigger={trigger}
      importRows={importRows}
      uncommittedByPath={props.uncommittedByPath}
      boundaryEl={props.boundaryEl}
    />
  );
}

function FolderLocationMenu(props: {
  readonly item: WorkspaceRunItem;
  readonly value: FolderLocationValue;
  readonly trigger: ReactNode;
  readonly importRows: ReadonlyArray<UnifiedPickerWorktreeRow>;
  readonly uncommittedByPath: ReadonlyMap<string, number>;
  readonly boundaryEl: HTMLElement | null;
}) {
  const { item, value, importRows } = props;
  return (
    // Non-modal so the menu's focus scope doesn't trap focus back into the menu:
    // that trap is what stole the search autofocus in the "Existing worktree"
    // submenu (its search input lives outside the roving menu-item focus).
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>{props.trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        data-testid="folder-location-menu"
        container={props.boundaryEl ?? undefined}
        className="w-[min(80vw,15rem)]"
      >
        <DropdownMenuItem
          data-testid="folder-location-local"
          onSelect={() => item.onSelectMode("local")}
        >
          <Laptop className="size-4" aria-hidden />
          <span className="flex-1">Local</span>
          {value === "local" ? (
            <Check className="size-4 text-primary" aria-hidden />
          ) : null}
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid="folder-location-worktree"
          onSelect={() => item.onSelectMode("worktree")}
        >
          <Split className="size-4 rotate-90" aria-hidden />
          <span className="flex-1">New worktree</span>
          {value === "worktree" ? (
            <Check className="size-4 text-primary" aria-hidden />
          ) : null}
        </DropdownMenuItem>
        {importRows.length === 0 ? null : (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-testid="folder-location-existing">
              <Split className="size-4 rotate-90" aria-hidden />
              <span className="flex-1">Existing worktree</span>
              {value === "import" ? (
                <Check className="size-4 text-primary" aria-hidden />
              ) : null}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-[min(90vw,22rem)]">
              <ExistingWorktreeList
                rows={importRows}
                promoteRowId={
                  importRows.find((row) => row.selected)?.id ?? null
                }
                uncommittedByPath={props.uncommittedByPath}
                onSelect={item.onEmit}
              />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {importRows.length === 0 ? (
          <DropdownMenuItem
            disabled
            data-testid="folder-location-existing-empty"
          >
            <ChevronRight className="size-4 opacity-0" aria-hidden />
            <span className="flex-1 text-muted-foreground">
              No existing worktrees
            </span>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The on-disk worktree list inside the Location "Existing worktree" submenu. The
 * list is always height-capped to ~5 rows and scrolls beyond that; a search bar
 * appears once the worktrees exceed {@link EXISTING_WORKTREE_SEARCH_THRESHOLD}.
 * Mounted only while the submenu is open, so the query resets per open and the
 * search autofocuses. `onKeyDown` stops propagation so the menu's typeahead
 * doesn't steal keystrokes (Escape still bubbles up to close the menu).
 */
function ExistingWorktreeList(props: {
  readonly rows: ReadonlyArray<UnifiedPickerWorktreeRow>;
  readonly promoteRowId: string | null;
  readonly uncommittedByPath: ReadonlyMap<string, number>;
  readonly onSelect: (intent: WorktreeFolderIntent) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const rows = useMemo(
    () => promotePickerRow(props.rows, props.promoteRowId),
    [props.rows, props.promoteRowId],
  );
  const showSearch = props.rows.length > EXISTING_WORKTREE_SEARCH_THRESHOLD;

  // A hover-opened Radix submenu keeps focus on its trigger and pulls focus back
  // off the search for a frame or two after open. Set the focus, then re-assert
  // it a bounded number of times when the menu reclaims it (the non-modal menu
  // above means nothing keeps trapping it afterwards), so the search ends up
  // focused without fighting a deliberate later focus change.
  useEffect(() => {
    if (!showSearch) return;
    const input = inputRef.current;
    if (input === null) return;
    let reclaims = 0;
    const focusSearch = (): void => {
      if (input.isConnected) input.focus();
    };
    const handleBlur = (): void => {
      if (reclaims >= 4) return;
      reclaims += 1;
      window.requestAnimationFrame(focusSearch);
    };
    const frame = window.requestAnimationFrame(focusSearch);
    input.addEventListener("blur", handleBlur);
    return () => {
      window.cancelAnimationFrame(frame);
      input.removeEventListener("blur", handleBlur);
    };
  }, [showSearch]);

  const needle = query.trim().toLowerCase();
  const filtered =
    needle.length === 0
      ? rows
      : rows.filter(
          (row) =>
            (row.branch ?? "").toLowerCase().includes(needle) ||
            row.worktreePath.toLowerCase().includes(needle),
        );

  return (
    <>
      {showSearch ? (
        <div className="pb-1">
          <InputGroup className="h-8! rounded-lg border-input/40 bg-input/25 shadow-none! *:data-[slot=input-group-addon]:pl-2!">
            <InputGroupInput
              ref={inputRef}
              value={query}
              placeholder="Search worktrees"
              aria-label="Search worktrees"
              className="text-ui-sm"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape") event.stopPropagation();
              }}
            />
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
          </InputGroup>
        </div>
      ) : null}
      <div
        // When the search bar is shown the height is PINNED (not capped) so
        // filtering the list down doesn't shrink the submenu and trigger Radix
        // to recompute/reposition it - that resize-on-every-keystroke is what
        // made the menu jump. Without search (<=5 rows, no filtering) keep it
        // snug with max-h.
        className={cn(
          "overflow-y-auto overscroll-contain",
          showSearch ? "h-[min(50vh,15rem)]" : "max-h-[min(50vh,15rem)]",
        )}
        data-testid="folder-location-existing-list"
      >
        {filtered.length === 0 ? (
          <div className="px-2 py-1.5 text-ui-sm text-muted-foreground">
            No matching worktrees
          </div>
        ) : (
          filtered.map((row) => {
            const uncommitted = props.uncommittedByPath.get(row.worktreePath);
            return (
              <DropdownMenuItem
                key={row.id}
                data-testid={`folder-location-import-${row.worktreePath}`}
                onSelect={() => props.onSelect(row.intent)}
              >
                {row.isLocked ? (
                  <Lock className="size-4 shrink-0" aria-hidden />
                ) : (
                  <Split className="size-4 shrink-0 rotate-90" aria-hidden />
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">
                    {row.branch ?? workspaceFolderName(row.worktreePath)}
                  </span>
                  <StartTruncatedText className="block text-ui-xs text-muted-foreground">
                    {row.worktreePath}
                  </StartTruncatedText>
                </span>
                {uncommitted !== undefined && uncommitted > 0 ? (
                  <span className="shrink-0 text-ui-xs text-muted-foreground">
                    {uncommitted} uncommitted
                  </span>
                ) : null}
                {row.selected ? (
                  <Check className="size-4 shrink-0 text-primary" aria-hidden />
                ) : null}
              </DropdownMenuItem>
            );
          })
        )}
      </div>
    </>
  );
}
