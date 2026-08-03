import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { WorktreeBindingSelectorRowV12 } from "@traycer/protocol/host";
import { WorktreeRowDisabledBadge } from "@/components/worktree/worktree-row-disabled-badge";
import type { WorktreeFolderRowBadge } from "@/lib/worktree/worktree-folder-disabled-reason";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { DropdownMenuLabel } from "@/components/ui/dropdown-menu";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { formatGitWorktreeLabel } from "@/lib/git/worktree-label";
import { cn } from "@/lib/utils";
import { worktreeRowKey } from "@/lib/worktree/worktree-row-key";

/**
 * Searchable "Workspaces" list over an epic's worktree bindings, shared by every
 * surface that picks a worktree (git diff panel, terminal creation, file
 * tree). Rows are rendered in the order given - callers own sorting and the
 * per-row filesystem path (`secondaryLabel`).
 */
export interface WorktreeFolderListProps {
  readonly rows: ReadonlyArray<WorktreeBindingSelectorRowV12>;
  readonly selectedRow: WorktreeBindingSelectorRowV12 | null;
  readonly secondaryLabel: (row: WorktreeBindingSelectorRowV12) => string;
  /**
   * Badge for a non-selectable row; `pending: true` renders muted with a
   * spinner (unverified facts, converging), otherwise destructive (a real
   * disabled reason).
   */
  readonly disabledBadge: (
    row: WorktreeBindingSelectorRowV12,
  ) => WorktreeFolderRowBadge | null;
  readonly onSelect: (row: WorktreeBindingSelectorRowV12) => void;
  /**
   * Focus the search input when the list mounts. Because the list mounts only
   * after the bindings query resolves, this grabs focus even when the list
   * appears *after* the popover opens. cmdk then owns arrow-key navigation and
   * Enter-to-select while focus stays in the input.
   */
  readonly autoFocusSearch: boolean;
  /** Shown when `rows` is empty. Callers own the copy since "no rows" means something different per surface (e.g. no worktrees at all vs. no directories in this epic). */
  readonly emptyMessage: string;
}

export function WorktreeFolderList(props: WorktreeFolderListProps): ReactNode {
  const selectedRowContentRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const selectedRowKey =
    props.selectedRow === null ? null : worktreeRowKey(props.selectedRow);

  useEffect(() => {
    if (selectedRowKey === null) return;
    selectedRowContentRef.current?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [selectedRowKey]);

  // Imperative focus (not the `autoFocus` JSX prop, which jsx-a11y forbids) on
  // mount. Since the list only mounts once bindings resolve, this also focuses
  // the input when the list appears *after* the popover opens.
  const { autoFocusSearch } = props;
  useEffect(() => {
    if (!autoFocusSearch) return;
    searchInputRef.current?.focus();
  }, [autoFocusSearch]);

  return (
    <section
      aria-label="Workspaces"
      className="p-2.5"
      data-testid="worktree-folder-list"
    >
      <DropdownMenuLabel className="px-1 text-ui-xs font-medium uppercase tracking-wide text-muted-foreground/70">
        Workspaces
      </DropdownMenuLabel>
      <Command className="rounded-none bg-transparent p-0">
        <CommandInput
          ref={searchInputRef}
          placeholder="Search repo, branch, or path…"
        />
        <CommandList>
          <CommandEmpty>{props.emptyMessage}</CommandEmpty>
          <CommandGroup>
            {props.rows.map((row) => {
              const label = formatGitWorktreeLabel(row);
              const secondary = props.secondaryLabel(row);
              const badge = props.disabledBadge(row);
              const disabled = badge !== null;
              const selected =
                selectedRowKey !== null &&
                worktreeRowKey(row) === selectedRowKey;

              return (
                <CommandItem
                  key={worktreeRowKey(row)}
                  value={`${label} ${secondary} ${row.runningDir}`}
                  disabled={disabled}
                  data-checked={selected ? "true" : undefined}
                  onSelect={() => {
                    if (disabled) return;
                    props.onSelect(row);
                  }}
                  className={cn(
                    !disabled &&
                      "cursor-pointer hover:bg-accent/60 hover:text-foreground data-selected:border-transparent data-selected:bg-accent/60 data-selected:text-foreground data-selected:shadow-none",
                  )}
                >
                  <div
                    ref={selected ? selectedRowContentRef : null}
                    className="min-w-0 flex-1"
                  >
                    <div className="truncate font-medium">{label}</div>
                    <StartTruncatedText className="block min-w-0 text-ui-xs text-muted-foreground">
                      {secondary}
                    </StartTruncatedText>
                  </div>
                  {badge === null ? null : (
                    <WorktreeRowDisabledBadge
                      label={badge.label}
                      pending={badge.pending}
                    />
                  )}
                </CommandItem>
              );
            })}
          </CommandGroup>
        </CommandList>
      </Command>
    </section>
  );
}
