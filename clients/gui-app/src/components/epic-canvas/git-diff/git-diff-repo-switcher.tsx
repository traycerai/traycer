import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Check, FileText, FolderGit2, Search } from "lucide-react";
import type { WorktreeBindingSelectorRowV12 } from "@traycer/protocol/host";
import { Badge } from "@/components/ui/badge";
import { WorktreeRowDisabledBadge } from "@/components/worktree/worktree-row-disabled-badge";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { WorktreePickerTrigger } from "@/components/worktree/worktree-picker-trigger";
import type { GitSubmoduleSummary } from "@/lib/git/git-repo-tree";
import {
  buildGitDiffRepoSwitcherModel,
  type GitDiffRepoSelection,
  type GitDiffRepoSwitcherModel,
  type GitDiffRepoSwitcherRootInput,
  type GitDiffRepoSwitcherRow,
} from "@/lib/git/git-diff-repo-switcher";
import { cn } from "@/lib/utils";

export interface GitDiffRepoSwitcherProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly roots: ReadonlyArray<GitDiffRepoSwitcherRootInput>;
  readonly activeRootSubmodules: ReadonlyArray<GitSubmoduleSummary>;
  readonly selected: GitDiffRepoSelection | null;
  readonly onSelectRoot: (row: WorktreeBindingSelectorRowV12) => void;
  readonly hostSection: ReactNode | null;
  readonly autoFocusSearch: boolean;
  readonly triggerClassName: string | undefined;
  readonly contentClassName: string | undefined;
  readonly triggerTestId: string;
  readonly contentTestId: string;
}

export function GitDiffRepoSwitcher(
  props: GitDiffRepoSwitcherProps,
): ReactNode {
  const [searchQuery, setSearchQuery] = useState("");
  const contentId = useId();
  const model = useMemo(
    () =>
      buildGitDiffRepoSwitcherModel({
        roots: props.roots,
        activeRootSubmodules: props.activeRootSubmodules,
        selected: props.selected,
        searchQuery,
      }),
    [props.activeRootSubmodules, props.roots, props.selected, searchQuery],
  );

  const handleSelectRoot = (row: WorktreeBindingSelectorRowV12): void => {
    props.onSelectRoot(row);
    props.onOpenChange(false);
  };

  return (
    <Popover open={props.open} onOpenChange={props.onOpenChange}>
      <PopoverTrigger asChild>
        <WorktreePickerTrigger
          worktreeLabel={model.trigger.label}
          secondaryLabel={model.trigger.secondaryLabel}
          changeCount={null}
          trailingStatus={
            <GitDiffCountBadges
              fileChangeCount={model.trigger.fileChangeCount}
              moduleChangeCount={model.trigger.moduleChangeCount}
            />
          }
          testId={props.triggerTestId}
          className={props.triggerClassName}
          aria-label={triggerAccessibleName(model)}
          title={triggerTooltip(model)}
          aria-haspopup="dialog"
          aria-expanded={props.open}
          aria-controls={props.open ? contentId : undefined}
          data-unavailable={model.trigger.unavailable ? "true" : undefined}
        />
      </PopoverTrigger>
      <PopoverContent
        id={contentId}
        role="dialog"
        aria-label="Git workspace selector"
        align="start"
        className={cn("w-[min(90vw,30rem)] gap-0 p-0", props.contentClassName)}
        data-testid={props.contentTestId}
      >
        {props.hostSection === null ? null : props.hostSection}
        <GitDiffRepoSwitcherDropdown
          model={model}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          onSelectRoot={handleSelectRoot}
          autoFocusSearch={props.autoFocusSearch}
        />
      </PopoverContent>
    </Popover>
  );
}

function triggerAccessibleName(model: GitDiffRepoSwitcherModel): string {
  const moduleLabel = changedSubmoduleLabel(model.trigger.moduleChangeCount);
  const fileLabel = changedFileLabel(model.trigger.fileChangeCount);
  const stateLabel = model.trigger.unavailable ? "unavailable" : null;
  return ["Git workspace", model.trigger.label, model.trigger.secondaryLabel]
    .concat(moduleLabel === null ? [] : [moduleLabel])
    .concat(fileLabel === null ? [] : [fileLabel])
    .concat(stateLabel === null ? [] : [stateLabel])
    .join(", ");
}

function triggerTooltip(model: GitDiffRepoSwitcherModel): string {
  const moduleLabel = changedSubmoduleLabel(model.trigger.moduleChangeCount);
  const fileLabel = changedFileLabel(model.trigger.fileChangeCount);
  return [
    `Workspace: ${model.trigger.label}`,
    `Path: ${model.trigger.secondaryLabel}`,
    moduleLabel === null ? null : moduleLabel,
    fileLabel === null ? null : fileLabel,
    model.trigger.unavailable ? "Status: unavailable" : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export interface GitDiffRepoSwitcherDropdownProps {
  readonly model: GitDiffRepoSwitcherModel;
  readonly searchQuery: string;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onSelectRoot: (row: WorktreeBindingSelectorRowV12) => void;
  readonly autoFocusSearch: boolean;
}

export function GitDiffRepoSwitcherDropdown(
  props: GitDiffRepoSwitcherDropdownProps,
): ReactNode {
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const { autoFocusSearch } = props;

  useEffect(() => {
    if (!autoFocusSearch) return;
    searchInputRef.current?.focus();
  }, [autoFocusSearch]);

  const handleSearchChange = (event: ChangeEvent<HTMLInputElement>): void => {
    props.onSearchQueryChange(event.currentTarget.value);
  };

  return (
    <section
      aria-label="Workspaces"
      className="p-2.5"
      data-testid="git-diff-repo-switcher-dropdown"
    >
      <div className="px-1 text-ui-xs font-medium tracking-wide text-muted-foreground/70 uppercase">
        Workspaces
      </div>
      <div className="pt-2 pb-2">
        <InputGroup className="h-8! rounded-lg border-input/40 bg-input/25 shadow-none! *:data-[slot=input-group-addon]:pl-2!">
          <InputGroupInput
            ref={searchInputRef}
            value={props.searchQuery}
            onChange={handleSearchChange}
            placeholder="Search branch, workspace, submodule, or path..."
            aria-label="Search workspaces"
          />
          <InputGroupAddon>
            <Search className="size-4" aria-hidden />
          </InputGroupAddon>
        </InputGroup>
      </div>
      <div
        role="listbox"
        aria-label="Workspaces"
        className="no-scrollbar max-h-[min(45vh,20rem)] overflow-y-auto"
      >
        {props.model.visibleRows.length === 0 ? (
          <div className="px-2 py-6 text-center text-ui-sm text-muted-foreground">
            No workspaces found.
          </div>
        ) : (
          props.model.visibleRows.map((row) => (
            <RepoSwitcherRowButton
              key={row.key}
              row={row}
              onSelectRoot={props.onSelectRoot}
            />
          ))
        )}
      </div>
    </section>
  );
}

function RepoSwitcherRowButton(props: {
  readonly row: GitDiffRepoSwitcherRow;
  readonly onSelectRoot: (row: WorktreeBindingSelectorRowV12) => void;
}): ReactNode {
  const { row } = props;
  const disabled = row.disabledLabel !== null;

  const handleClick = (): void => {
    if (row.disabledLabel !== null) return;
    props.onSelectRoot(row.row);
  };

  return (
    <button
      type="button"
      role="option"
      aria-selected={row.selected}
      aria-disabled={disabled ? true : undefined}
      data-kind={row.kind}
      data-depth={row.depth}
      data-clean={row.clean ? "true" : undefined}
      data-git-diff-repo-switcher-option="true"
      data-testid={`git-diff-repo-switcher-root-${row.label}`}
      onClick={handleClick}
      onKeyDown={handleRepoSwitcherRowKeyDown}
      className={cn(
        "group flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-sm transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        row.selected
          ? "bg-accent text-accent-foreground"
          : "hover:bg-accent/50",
        disabled && "cursor-default opacity-50 hover:bg-transparent",
      )}
    >
      <RepoSwitcherRowIcon />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate font-medium">
            {row.headLabel ?? row.label}
          </span>
          {row.headLabel === null ? null : (
            <span className="min-w-0 shrink truncate text-ui-xs text-muted-foreground">
              {row.label}
            </span>
          )}
        </div>
        <StartTruncatedText className="block min-w-0 text-ui-xs text-muted-foreground">
          {row.secondaryLabel}
        </StartTruncatedText>
      </div>
      <RepoSwitcherRowMarker row={row} />
      <Check
        className={cn(
          "size-3.5 shrink-0 text-primary transition-opacity",
          row.selected ? "opacity-100" : "opacity-0",
        )}
        aria-hidden
      />
    </button>
  );
}

function handleRepoSwitcherRowKeyDown(
  event: KeyboardEvent<HTMLButtonElement>,
): void {
  if (
    event.key !== "ArrowDown" &&
    event.key !== "ArrowUp" &&
    event.key !== "Home" &&
    event.key !== "End"
  ) {
    return;
  }
  event.preventDefault();
  focusRepoSwitcherOption(event.currentTarget, event.key);
}

function focusRepoSwitcherOption(
  current: HTMLButtonElement,
  key: string,
): void {
  const container = current.parentElement;
  if (container === null) return;
  const options = Array.from(
    container.querySelectorAll<HTMLButtonElement>(
      "[data-git-diff-repo-switcher-option='true']",
    ),
  );
  const currentIndex = options.indexOf(current);
  if (currentIndex === -1) return;
  const lastIndex = options.length - 1;
  if (key === "Home") {
    options[0].focus();
    return;
  }
  if (key === "End") {
    options[lastIndex].focus();
    return;
  }
  if (key === "ArrowUp") {
    options[Math.max(0, currentIndex - 1)].focus();
    return;
  }
  options[Math.min(lastIndex, currentIndex + 1)].focus();
}

function RepoSwitcherRowIcon(): ReactNode {
  return (
    <FolderGit2
      className="size-3.5 shrink-0 text-muted-foreground"
      aria-hidden
    />
  );
}

function RepoSwitcherRowMarker(props: {
  readonly row: GitDiffRepoSwitcherRow;
}): ReactNode {
  const { row } = props;
  if (row.disabledLabel !== null) {
    return (
      <WorktreeRowDisabledBadge
        label={row.disabledLabel}
        pending={row.pending}
      />
    );
  }
  return (
    <GitDiffCountBadges
      fileChangeCount={row.fileChangeCount}
      moduleChangeCount={row.moduleChangeCount}
    />
  );
}

function GitDiffCountBadges(props: {
  readonly fileChangeCount: number | null;
  readonly moduleChangeCount: number | null;
}): ReactNode {
  const moduleLabel = changedSubmoduleLabel(props.moduleChangeCount);
  const fileLabel = changedFileLabel(props.fileChangeCount);
  if (moduleLabel === null && fileLabel === null) return null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {moduleLabel === null ? null : (
        <Badge
          variant="secondary"
          className="gap-1 px-1.5 tabular-nums"
          aria-label={moduleLabel}
          title={moduleLabel}
        >
          <FolderGit2 className="size-3" aria-hidden />
          <span aria-hidden>{props.moduleChangeCount}</span>
        </Badge>
      )}
      {fileLabel === null ? null : (
        <Badge
          variant="secondary"
          className="gap-1 px-1.5 tabular-nums"
          aria-label={fileLabel}
          title={fileLabel}
        >
          <FileText className="size-3" aria-hidden />
          <span aria-hidden>{props.fileChangeCount}</span>
        </Badge>
      )}
    </span>
  );
}

function changedSubmoduleLabel(count: number | null): string | null {
  if (count === null || count === 0) return null;
  return count === 1 ? "1 changed submodule" : `${count} changed submodules`;
}

function changedFileLabel(count: number | null): string | null {
  if (count === null || count === 0) return null;
  return count === 1 ? "1 changed file" : `${count} changed files`;
}
