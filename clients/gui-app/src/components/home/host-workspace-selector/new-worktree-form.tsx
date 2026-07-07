import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Search } from "lucide-react";
import type {
  WorktreeFolderIntent,
  WorktreeWorkspaceSummary,
} from "@traycer/protocol/host/worktree-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { PickerOptionButton } from "@/components/home/worktree/worktree-branch-picker-options";
import type { WorktreeBranchPickerRow } from "@/components/home/worktree/worktree-branch-picker-model";
import { useHostQuery } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";
import {
  createWorktreeBranchSearchIndex,
  filterWorktreeBranchRows,
  pathSearchBasename,
  pathSearchTail,
} from "@/components/home/data/worktree-branch-search";
import {
  buildUnifiedPickerModel,
  newWorktreeIntent,
  type UnifiedPickerModel,
  type UnifiedPickerSourceOption,
} from "@/components/home/worktree/worktree-unified-picker-model";
import { promotePickerRow } from "./promote-picker-row";

type RepoIdentifier = WorktreeFolderIntent["repoIdentifier"];

export interface NewWorktreeFormProps {
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  readonly workspacePath: string;
  readonly repoIdentifier: RepoIdentifier;
  readonly isPrimary: boolean;
  readonly summary: WorktreeWorkspaceSummary;
  readonly currentIntent: WorktreeFolderIntent | null;
  readonly defaultNewBranchName: string;
  /** Emits exactly one worktree intent for this workspace. */
  readonly onEmit: (intent: WorktreeFolderIntent) => void;
  /** Called after a successful emit so the host popover can close on commit. */
  readonly onCommitted: () => void;
}

/**
 * The new-branch → worktree form, hosted inside the Branch chip's popover. The
 * Source selector is an inline {@link SourceBranchList} (search + scrollable
 * list, no nested dropdown) so the whole picker reads as one cohesive panel; the
 * model is built from {@link buildUnifiedPickerModel} and the emitted intent
 * comes from {@link newWorktreeIntent}.
 *
 * The branch name is always required: New worktree always creates a new branch
 * from the selected source, never a direct checkout of the source branch.
 */
export function NewWorktreeForm(props: NewWorktreeFormProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const branchesQuery = useHostQuery<HostRpcRegistry, "worktree.listBranches">({
    cacheKeyIdentity: undefined,
    client: props.hostClient,
    method: "worktree.listBranches",
    params: { workspacePath: props.workspacePath, includeRemote: true },
    options: { enabled: true },
  });

  const model = useMemo<UnifiedPickerModel>(
    () =>
      buildUnifiedPickerModel({
        summary: props.summary,
        branches: branchesQuery.data?.branches ?? [],
        currentIntent: props.currentIntent,
        defaultNewBranchName: props.defaultNewBranchName,
        uncommittedFileCount: branchesQuery.data?.uncommittedFileCount ?? 0,
      }),
    [
      branchesQuery.data,
      props.currentIntent,
      props.defaultNewBranchName,
      props.summary,
    ],
  );

  const form = useNewWorktreeFormState(
    model,
    props.currentIntent,
    props.defaultNewBranchName,
  );
  const { selectedSource } = form;
  const trimmed = form.branchName.trim();
  const canCreate = canCreateWorktree(
    selectedSource,
    trimmed,
    props.currentIntent,
  );

  const submit = (): void => {
    if (selectedSource === null) return;
    if (trimmed.length === 0) return;
    const intent = newWorktreeIntent({
      workspacePath: props.workspacePath,
      repoIdentifier: props.repoIdentifier,
      isPrimary: props.isPrimary,
      source: selectedSource,
      branchName: trimmed,
    });
    if (intent === null) return;
    props.onEmit(intent);
    // Close the host popover once the worktree intent is committed.
    props.onCommitted();
  };

  const sourceRows = buildSourceRows(
    model,
    selectedSource?.id ?? null,
    branchesQuery.data?.uncommittedFileCount ?? 0,
  );
  const branchName = form.branchName;
  const handleChangeName = form.setBranchName;
  const handleSelectSource = form.selectSource;
  const namePlaceholder = "New branch name (required)";

  return (
    <div className="flex flex-col gap-2.5" data-testid="new-worktree-form">
      <div className="flex flex-col gap-1">
        <span className="pl-1 text-ui-xs font-medium text-muted-foreground">
          Source
        </span>
        <SourceBranchList
          rows={sourceRows}
          promoteRowId={model.newBranchSourceId}
          isLoading={branchesQuery.isLoading}
          emptyLabel="No branches available"
          onSelect={handleSelectSource}
        />
      </div>
      <div className="flex flex-col gap-1">
        <span className="pl-1 text-ui-xs font-medium text-muted-foreground">
          New branch name
        </span>
        <Input
          ref={inputRef}
          value={branchName}
          spellCheck={false}
          aria-label="New branch name"
          placeholder={namePlaceholder}
          className="h-8 text-ui-sm"
          data-testid="new-worktree-branch-name"
          onChange={(event) => handleChangeName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
        />
      </div>
      <div className="flex items-center justify-end">
        <Button
          type="button"
          size="sm"
          disabled={!canCreate}
          aria-label="Select worktree"
          data-testid="new-worktree-select"
          onClick={submit}
        >
          Select
        </Button>
      </div>
    </div>
  );
}

export interface ImportedWorktreeBranchFormProps {
  readonly sourceBranch: string;
  readonly currentBranchName: string;
}

/**
 * Read-only mirror of the new-worktree branch form for an adopted on-disk
 * worktree: Source shows the detected/fallback source branch with the selected
 * tick, and New branch name shows the worktree's current branch. No controls
 * mutate state; this is only an inspectable explanation of the existing binding.
 */
export function ImportedWorktreeBranchForm(
  props: ImportedWorktreeBranchFormProps,
) {
  const sourceRow = importedWorktreeSourceRow(props.sourceBranch);
  return (
    <div
      className="flex flex-col gap-2.5"
      data-testid="import-worktree-branch-form"
    >
      <div className="flex flex-col gap-1">
        <span className="pl-1 text-ui-xs font-medium text-muted-foreground">
          Source
        </span>
        <div
          role="listbox"
          aria-label="Worktree source branch"
          className="max-h-[min(40vh,12rem)] overflow-y-auto overscroll-contain"
          data-testid="import-worktree-source-list"
        >
          <PickerOptionButton
            id="import-worktree-source"
            option={sourceRow}
            active={false}
            tabIndex={-1}
            onActive={() => undefined}
            onSelect={() => undefined}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <span className="pl-1 text-ui-xs font-medium text-muted-foreground">
          New branch name
        </span>
        <Input
          value={props.currentBranchName}
          readOnly
          aria-readonly
          aria-label="New branch name"
          className="h-8 text-ui-sm"
          data-testid="import-worktree-branch-name"
        />
      </div>
    </div>
  );
}

/** The active row's index in the filtered list: the arrow-highlighted row while
 * it's still present, else the selected source, else the top (−1 when empty). */
function sourceActiveIndex(
  filtered: ReadonlyArray<WorktreeBranchPickerRow>,
  activeId: string | null,
): number {
  if (filtered.length === 0) return -1;
  const picked =
    activeId === null
      ? -1
      : filtered.findIndex((row) => row.value === activeId);
  if (picked !== -1) return picked;
  const selected = filtered.findIndex((row) => row.selected);
  return selected === -1 ? 0 : selected;
}

/**
 * The inline source-branch picker: a search box (autofocused) over a scrollable
 * list of fork sources, rendered directly in the form — no nested
 * dropdown, so the whole picker reads as one panel. It is a combobox: the
 * options are arrow-navigated and Enter selects the active row, so Tab moves on
 * to the New branch name field. Reuses {@link PickerOptionButton} for the row
 * styling / selected check / full-name tooltip, and the shared branch search
 * index for filtering.
 */
function SourceBranchList(props: {
  readonly rows: ReadonlyArray<WorktreeBranchPickerRow>;
  readonly promoteRowId: string | null;
  /** Branches are still being fetched — show a spinner instead of the list. */
  readonly isLoading: boolean;
  readonly emptyLabel: string;
  readonly onSelect: (value: string) => void;
}) {
  const idPrefix = useId();
  const listboxId = `${idPrefix}-listbox`;
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const rows = useMemo(
    () => promotePickerRow(props.rows, props.promoteRowId),
    [props.rows, props.promoteRowId],
  );
  // The active (arrow-highlighted) row is tracked by its stable id, not a raw
  // index, so it survives re-filtering. `sourceActiveIndex` re-derives the
  // position and falls back to the selected source (or top) when the highlight
  // leaves the filtered set — no state-syncing effect needed.
  const [activeId, setActiveId] = useState<string | null>(null);
  const searchIndex = useMemo(
    () => createWorktreeBranchSearchIndex(rows),
    [rows],
  );
  const filtered = useMemo(
    () => filterWorktreeBranchRows(rows, searchIndex, query),
    [rows, searchIndex, query],
  );
  const activeIndex = sourceActiveIndex(filtered, activeId);
  const activeRow = activeIndex === -1 ? undefined : filtered[activeIndex];

  // Autofocus the search on mount.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const moveActive = (delta: number): void => {
    if (filtered.length === 0) return;
    const base = activeIndex === -1 ? 0 : activeIndex;
    const next = Math.min(Math.max(base + delta, 0), filtered.length - 1);
    setActiveId(filtered[next].value);
    const node = listRef.current?.children[next];
    if (node instanceof HTMLElement) node.scrollIntoView({ block: "nearest" });
  };

  let listBody: ReactNode;
  if (props.isLoading) {
    // Branches are still being fetched — the popover is already open, so show a
    // spinner inside instead of an empty / sparse list.
    listBody = (
      <div className="flex items-center justify-center gap-2 px-2 py-6 text-ui-sm text-muted-foreground">
        <AgentSpinningDots
          className="text-current"
          testId={undefined}
          variant="dots"
        />
        <span>Loading branches…</span>
      </div>
    );
  } else if (filtered.length === 0) {
    listBody = (
      <div className="px-2 py-1.5 text-ui-sm text-muted-foreground">
        {props.emptyLabel}
      </div>
    );
  } else {
    listBody = filtered.map((row, index) => (
      <PickerOptionButton
        key={row.id}
        id={`${idPrefix}-${row.id}`}
        option={row}
        active={index === activeIndex}
        tabIndex={-1}
        onActive={() => setActiveId(row.value)}
        onSelect={() => props.onSelect(row.value)}
      />
    ));
  }

  // A combobox: focus stays on the search box, the options are arrow-navigated
  // (tabIndex -1 + aria-activedescendant), and Tab moves on to the New branch
  // name field instead of stepping through every branch.
  return (
    <div className="flex flex-col gap-1.5">
      <InputGroup className="h-8! rounded-lg border-input/40 bg-input/25 shadow-none! *:data-[slot=input-group-addon]:pl-2!">
        <InputGroupInput
          ref={inputRef}
          role="combobox"
          aria-expanded
          aria-controls={listboxId}
          aria-activedescendant={
            props.isLoading || activeRow === undefined
              ? undefined
              : `${idPrefix}-${activeRow.id}`
          }
          value={query}
          placeholder="Search branches"
          aria-label="Search branches"
          className="text-ui-sm"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              moveActive(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              moveActive(-1);
            } else if (event.key === "Home") {
              event.preventDefault();
              moveActive(-filtered.length);
            } else if (event.key === "End") {
              event.preventDefault();
              moveActive(filtered.length);
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (activeRow !== undefined) props.onSelect(activeRow.value);
            }
          }}
        />
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
      </InputGroup>
      <div
        ref={listRef}
        id={listboxId}
        role="listbox"
        aria-label="Worktree source branch"
        className="max-h-[min(40vh,12rem)] overflow-y-auto overscroll-contain"
        data-testid="new-worktree-source-list"
      >
        {listBody}
      </div>
    </div>
  );
}

interface NewWorktreeFormState {
  readonly selectedSource: UnifiedPickerSourceOption | null;
  readonly branchName: string;
  readonly setBranchName: (next: string) => void;
  readonly selectSource: (next: string) => void;
}

/**
 * Resolves the selected source + the branch-name prefill. The
 * "edited" flag lives in state (not a ref) so when the user switches source
 * WITHOUT typing, the prefill is re-derived for the new source during render
 * (the React-sanctioned "adjust state on a changed input" pattern). A
 * user-edited name is preserved.
 */
function useNewWorktreeFormState(
  model: UnifiedPickerModel,
  currentIntent: WorktreeFolderIntent | null,
  defaultNewBranchName: string,
): NewWorktreeFormState {
  const sourceOptions = model.sourceOptions;
  const [sourceId, setSourceId] = useState<string | null>(null);
  const selectedId =
    sourceId !== null && sourceOptions.some((option) => option.id === sourceId)
      ? sourceId
      : model.newBranchSourceId;
  const selectedSource =
    sourceOptions.find((option) => option.id === selectedId) ??
    (sourceOptions.length === 0 ? null : sourceOptions[0]);
  const selectedSourceId = selectedSource?.id ?? null;

  const [nameState, setNameState] = useState(() => ({
    value: initialNewBranchName(
      currentIntent,
      selectedSource,
      defaultNewBranchName,
    ),
    forSource: selectedSourceId,
    edited: false,
  }));
  if (!nameState.edited && nameState.forSource !== selectedSourceId) {
    setNameState({
      value: initialNewBranchName(
        currentIntent,
        selectedSource,
        defaultNewBranchName,
      ),
      forSource: selectedSourceId,
      edited: false,
    });
  }

  return {
    selectedSource,
    branchName: nameState.value,
    setBranchName: (next) =>
      setNameState((prev) => ({ ...prev, value: next, edited: true })),
    selectSource: setSourceId,
  };
}

/** Whether Select is enabled: a source is chosen, the form differs from any
 * staged intent, and a new branch name is typed. */
function canCreateWorktree(
  selectedSource: UnifiedPickerSourceOption | null,
  trimmedName: string,
  currentIntent: WorktreeFolderIntent | null,
): boolean {
  if (selectedSource === null) return false;
  const stagedMatchesForm =
    currentIntent?.kind === "worktree" &&
    matchesStagedBranch(currentIntent.branch, trimmedName, selectedSource);
  if (stagedMatchesForm) return false;
  return trimmedName.length > 0;
}

/** The Source dropdown rows, mapped 1:1 from the model's ordered source list
 * (working-tree carry → clean current-branch fork → branches), reusing the
 * shared branch-picker row shape. The carry row carries the uncommitted-count
 * badge; remote refs carry a "remote" badge. `value` is the source `id` so the
 * carry and clean current-branch rows (same branch name) stay distinct. */
function buildSourceRows(
  model: UnifiedPickerModel,
  selectedSourceId: string | null,
  workingTreeUncommitted: number,
): ReadonlyArray<WorktreeBranchPickerRow> {
  return model.sourceOptions.map((option) => ({
    id: option.id,
    value: option.id,
    // The carry row shows "Working tree · <branch>"; every other row shows the
    // bare branch name and conveys remote-ness via the badge, not a label prefix.
    primaryLabel: option.carryUncommittedChanges ? option.label : option.name,
    secondaryLabel: null,
    secondaryTitle: null,
    badges: sourceRowBadges(option, workingTreeUncommitted),
    selected: selectedSourceId === option.id,
    disabled: false,
    disabledReason: null,
    testId: option.carryUncommittedChanges
      ? "unified-picker-source-working-tree"
      : `unified-picker-source-${option.name}`,
    searchBranch: option.name,
    searchPathTail: pathSearchTail(option.name),
    searchPathBasename: pathSearchBasename(option.name),
    searchFullPath: option.name,
  }));
}

/** The carry row badges its uncommitted count; remote refs badge "remote"; every
 * other source has no badge. */
function sourceRowBadges(
  option: UnifiedPickerSourceOption,
  workingTreeUncommitted: number,
): ReadonlyArray<string> {
  if (option.carryUncommittedChanges) {
    return workingTreeUncommitted > 0
      ? [`${workingTreeUncommitted} uncommitted`]
      : [];
  }
  return option.isRemote ? ["remote"] : [];
}

function importedWorktreeSourceRow(
  sourceBranch: string,
): WorktreeBranchPickerRow {
  return {
    id: `import-source:${sourceBranch}`,
    value: sourceBranch,
    primaryLabel: sourceBranch,
    secondaryLabel: null,
    secondaryTitle: null,
    badges: [],
    selected: true,
    disabled: false,
    disabledReason: null,
    testId: "import-worktree-source-branch",
    searchBranch: sourceBranch,
    searchPathTail: pathSearchTail(sourceBranch),
    searchPathBasename: pathSearchBasename(sourceBranch),
    searchFullPath: sourceBranch,
  };
}

/**
 * The prefilled name. A staged new-branch worktree shows its staged name;
 * otherwise the selected source's generated default is used.
 */
function initialNewBranchName(
  intent: WorktreeFolderIntent | null,
  source: UnifiedPickerSourceOption | null,
  fallback: string,
): string {
  if (intent?.kind === "worktree" && intent.branch.type === "new") {
    return intent.branch.name;
  }
  return source?.defaultNewBranchName ?? fallback;
}

function matchesStagedBranch(
  branch: Extract<WorktreeFolderIntent, { kind: "worktree" }>["branch"],
  trimmedName: string,
  source: UnifiedPickerSourceOption | null,
): boolean {
  if (branch.type === "new") {
    // Carry vs clean share a source name, so the carry flag is part of identity:
    // switching between them must register as a change (Select re-enables).
    return (
      source !== null &&
      branch.name === trimmedName &&
      branch.source === source.name &&
      branch.carryUncommittedChanges === source.carryUncommittedChanges
    );
  }
  return false;
}
