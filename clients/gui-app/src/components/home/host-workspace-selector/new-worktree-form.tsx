import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Search } from "lucide-react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type {
  WorktreeFolderIntent,
  WorktreeWorkspaceSummary,
} from "@traycer/protocol/host/worktree-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { Input } from "@/components/ui/input";
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

const WORKTREE_AUTOSAVE_DELAY_MS = 500;
/** One-line row block size: `leading-5` plus `py-1.5`, scalable with root text. */
const SOURCE_ROW_BLOCK_SIZE_REM = 2;
/** Virtuoso startup estimate only; rendered rows are measured after mount. */
const SOURCE_ROW_HEIGHT_ESTIMATE_PX = 32;
/** Shared viewport-aware limits for loaded and placeholder source lists. */
const SOURCE_LIST_HEIGHT_LIMITS = "40vh, 12rem";
const SOURCE_LIST_HEIGHT_CAP = `min(${SOURCE_LIST_HEIGHT_LIMITS})`;

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
  const draftIntent = useMemo(
    () =>
      selectedSource === null
        ? null
        : newWorktreeIntent({
            workspacePath: props.workspacePath,
            repoIdentifier: props.repoIdentifier,
            isPrimary: props.isPrimary,
            source: selectedSource,
            branchName: trimmed,
          }),
    [
      props.isPrimary,
      props.repoIdentifier,
      props.workspacePath,
      selectedSource,
      trimmed,
    ],
  );
  const preservesExistingBranchCheckout =
    props.currentIntent?.kind === "worktree" &&
    props.currentIntent.branch.type === "existing" &&
    !form.hasUserEdited;
  const isSaved =
    preservesExistingBranchCheckout ||
    (draftIntent?.kind === "worktree" &&
      props.currentIntent?.kind === "worktree" &&
      matchesStagedBranch(
        props.currentIntent.branch,
        draftIntent.branch.name,
        selectedSource,
      ));
  const { flush } = useNewWorktreeAutosave({
    draftIntent,
    isSaved,
    onEmit: props.onEmit,
    retainPendingDraft: form.hasUnresolvedExplicitSource && trimmed.length > 0,
  });

  const selectedSourceId = selectedSource?.id ?? null;
  const uncommittedFileCount = branchesQuery.data?.uncommittedFileCount ?? 0;
  const sourceRows = useMemo(
    () => buildSourceRows(model, selectedSourceId, uncommittedFileCount),
    [model, selectedSourceId, uncommittedFileCount],
  );
  const branchName = form.branchName;
  const handleChangeName = form.setBranchName;
  const handleSelectSource = form.selectSource;
  const namePlaceholder = "New branch name (required)";

  return (
    <div
      className="flex flex-col gap-2.5"
      data-testid="new-worktree-form"
      onBlurCapture={(event) => {
        if (event.target instanceof HTMLInputElement && event.target.disabled) {
          return;
        }
        const nextTarget = event.relatedTarget;
        if (
          nextTarget instanceof Node &&
          event.currentTarget.contains(nextTarget)
        ) {
          return;
        }
        flush();
      }}
    >
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
          value={branchName}
          disabled={selectedSource === null}
          spellCheck={false}
          aria-label="New branch name"
          placeholder={namePlaceholder}
          className="h-8 text-ui-sm"
          data-testid="new-worktree-branch-name"
          onChange={(event) => handleChangeName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              flush();
            }
          }}
        />
      </div>
      <div className="flex min-h-4 items-center justify-end px-1">
        <span
          role="status"
          aria-live="polite"
          className="text-ui-xs text-muted-foreground"
          data-testid="new-worktree-save-status"
        >
          {autosaveStatusLabel(draftIntent, isSaved, trimmed.length > 0)}
        </span>
      </div>
    </div>
  );
}

export interface ImportedWorktreeBranchFormProps {
  readonly sourceBranch: string;
  readonly currentBranchName: string;
}

/**
 * Read-only branch metadata for an adopted on-disk worktree. A definition list
 * keeps the detected/fallback source and current branch inspectable without
 * presenting either value as a selectable option or editable field.
 */
export function ImportedWorktreeBranchForm(
  props: ImportedWorktreeBranchFormProps,
) {
  return (
    <dl
      className="flex flex-col gap-3 px-1 py-0.5"
      data-testid="import-worktree-branch-form"
    >
      <div className="min-w-0">
        <dt className="text-ui-xs font-medium text-muted-foreground">
          Source branch
        </dt>
        <dd
          title={props.sourceBranch}
          className="mt-1 min-w-0 truncate text-ui-sm text-foreground/85"
          data-testid="import-worktree-source-branch"
        >
          {props.sourceBranch}
        </dd>
      </div>
      <div className="min-w-0">
        <dt className="text-ui-xs font-medium text-muted-foreground">
          Current branch
        </dt>
        <dd
          title={props.currentBranchName}
          className="mt-1 min-w-0 truncate text-ui-sm text-foreground/85"
          data-testid="import-worktree-branch-name"
        >
          {props.currentBranchName}
        </dd>
      </div>
    </dl>
  );
}

function useNewWorktreeAutosave(input: {
  readonly draftIntent: WorktreeFolderIntent | null;
  readonly isSaved: boolean;
  readonly onEmit: (intent: WorktreeFolderIntent) => void;
  readonly retainPendingDraft: boolean;
}): { readonly flush: () => void } {
  const timeoutRef = useRef<number | null>(null);
  const pendingIntentRef = useRef<WorktreeFolderIntent | null>(null);
  const interactiveFlushAllowedRef = useRef(false);
  const mountCycleRef = useRef(0);
  const onEmitRef = useRef(input.onEmit);

  useEffect(() => {
    onEmitRef.current = input.onEmit;
  }, [input.onEmit]);

  const emitPending = useCallback((): void => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    const pendingIntent = pendingIntentRef.current;
    pendingIntentRef.current = null;
    interactiveFlushAllowedRef.current = false;
    if (pendingIntent !== null) onEmitRef.current(pendingIntent);
  }, []);

  const flush = useCallback((): void => {
    if (!interactiveFlushAllowedRef.current) return;
    emitPending();
  }, [emitPending]);

  useEffect(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    interactiveFlushAllowedRef.current = false;
    if (input.draftIntent === null) {
      if (!input.retainPendingDraft) pendingIntentRef.current = null;
      return;
    }
    pendingIntentRef.current = null;
    if (input.isSaved) return;

    pendingIntentRef.current = input.draftIntent;
    interactiveFlushAllowedRef.current = true;
    timeoutRef.current = window.setTimeout(flush, WORKTREE_AUTOSAVE_DELAY_MS);

    return () => {
      if (timeoutRef.current === null) return;
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    };
  }, [flush, input.draftIntent, input.isSaved, input.retainPendingDraft]);

  useEffect(() => {
    const mountCycle = mountCycleRef.current + 1;
    mountCycleRef.current = mountCycle;
    return () => {
      // Closing the popover must flush its latest valid draft, but React
      // StrictMode also runs a synthetic setup → cleanup → setup mount cycle.
      // Deferring one microtask lets the second setup supersede that synthetic
      // cleanup without weakening a real click-away / Escape unmount.
      queueMicrotask(() => {
        if (mountCycleRef.current === mountCycle) emitPending();
      });
    };
  }, [emitPending]);

  return { flush };
}

function autosaveStatusLabel(
  draftIntent: WorktreeFolderIntent | null,
  isSaved: boolean,
  hasBranchName: boolean,
): string {
  if (draftIntent === null) {
    return hasBranchName ? "Waiting for source…" : "Branch name required";
  }
  return isSaved ? "Saved" : "Saving…";
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
const SourceBranchList = memo(function SourceBranchList(props: {
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
  const listRef = useRef<VirtuosoHandle | null>(null);
  const [query, setQuery] = useState("");
  // Promotion is an open-time affordance. Parent autosave echoes can update the
  // staged source while this form is mounted, but must not reorder the list
  // underneath the user. A fresh popover mount adopts the newly staged source.
  const [initialPromoteRowId] = useState(() => props.promoteRowId);
  const rows = useMemo(
    () => promotePickerRow(props.rows, initialPromoteRowId),
    [props.rows, initialPromoteRowId],
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
  // Filtered identity/order only — never fold selection into a Virtuoso key.
  // Selection used to remount the scroller (focus → body → spurious flush);
  // filter keystrokes used to rebuild it every character. Let Virtuoso diff
  // `data` and scroll the active option into view imperatively.
  const filteredOrderKey = useMemo(
    () => filtered.map((row) => row.id).join("\u0000"),
    [filtered],
  );
  const listHeight = `min(${Math.max(filtered.length, 1) * SOURCE_ROW_BLOCK_SIZE_REM}rem, ${SOURCE_LIST_HEIGHT_LIMITS})`;
  // Pure render: aria-activedescendant tracks the current active row id.
  // During virtualized scroll it may briefly name an off-window option — an
  // accepted ARIA limitation vs mounted-gating state/effects that failed lint.
  const comboboxAriaActiveDescendant =
    props.isLoading || activeRow === undefined
      ? undefined
      : `${idPrefix}-${activeRow.id}`;

  const rowContext = useMemo<SourceBranchListRowContext>(
    () => ({
      activeIndex,
      idPrefix,
      onSelect: props.onSelect,
      setActiveId,
    }),
    [activeIndex, idPrefix, props.onSelect],
  );

  // Autofocus the search on mount.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  // Keep the active option scrolled into the virtual window after filter
  // changes and Home/End jumps. External scroller sync only — no React state.
  useEffect(() => {
    if (activeIndex < 0) return;
    listRef.current?.scrollIntoView({
      index: activeIndex,
      behavior: "auto",
    });
  }, [activeIndex, filteredOrderKey]);

  const moveActive = (delta: number): void => {
    if (filtered.length === 0) return;
    const base = activeIndex === -1 ? 0 : activeIndex;
    const next = Math.min(Math.max(base + delta, 0), filtered.length - 1);
    setActiveId(filtered[next].value);
    listRef.current?.scrollIntoView({ index: next, behavior: "auto" });
  };

  let sourceList: ReactNode;
  if (props.isLoading) {
    // Branches are still being fetched — the popover is already open, so show a
    // spinner inside instead of an empty / sparse list.
    sourceList = (
      <div
        id={listboxId}
        role="listbox"
        aria-label="Worktree source branch"
        className="overflow-y-auto overscroll-contain"
        style={{ maxHeight: SOURCE_LIST_HEIGHT_CAP }}
        data-testid="new-worktree-source-list"
      >
        <div className="flex items-center justify-center gap-2 px-2 py-6 text-ui-sm text-muted-foreground">
          <AgentSpinningDots
            className="text-current"
            testId={undefined}
            variant="dots"
          />
          <span>Loading branches…</span>
        </div>
      </div>
    );
  } else if (filtered.length === 0) {
    sourceList = (
      <div
        id={listboxId}
        role="listbox"
        aria-label="Worktree source branch"
        className="overflow-y-auto overscroll-contain"
        style={{ maxHeight: SOURCE_LIST_HEIGHT_CAP }}
        data-testid="new-worktree-source-list"
      >
        <div className="px-2 py-1.5 text-ui-sm text-muted-foreground">
          {props.emptyLabel}
        </div>
      </div>
    );
  } else {
    sourceList = (
      <div style={{ height: listHeight }}>
        <Virtuoso<WorktreeBranchPickerRow, SourceBranchListRowContext>
          ref={listRef}
          id={listboxId}
          role="listbox"
          tabIndex={-1}
          aria-label="Worktree source branch"
          className="h-full overscroll-contain"
          data={filtered}
          computeItemKey={sourceBranchRowKey}
          defaultItemHeight={SOURCE_ROW_HEIGHT_ESTIMATE_PX}
          increaseViewportBy={64}
          initialItemCount={Math.min(filtered.length, 12)}
          initialTopMostItemIndex={{ index: activeIndex, align: "center" }}
          context={rowContext}
          data-testid="new-worktree-source-list"
          itemContent={renderSourceBranchRow}
        />
      </div>
    );
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
          aria-activedescendant={comboboxAriaActiveDescendant}
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
      {sourceList}
    </div>
  );
});

interface SourceBranchListRowContext {
  readonly activeIndex: number;
  readonly idPrefix: string;
  readonly onSelect: (value: string) => void;
  readonly setActiveId: (value: string) => void;
}

function renderSourceBranchRow(
  index: number,
  row: WorktreeBranchPickerRow | undefined,
  context: SourceBranchListRowContext,
): ReactNode {
  if (row === undefined) return null;
  return (
    <PickerOptionButton
      id={`${context.idPrefix}-${row.id}`}
      option={row}
      active={index === context.activeIndex}
      tabIndex={-1}
      onActive={() => context.setActiveId(row.value)}
      onSelect={() => context.onSelect(row.value)}
    />
  );
}

function sourceBranchRowKey(
  index: number,
  row: WorktreeBranchPickerRow | undefined,
): string {
  return row?.id ?? `transient-row-${index}`;
}

interface NewWorktreeFormState {
  readonly selectedSource: UnifiedPickerSourceOption | null;
  readonly branchName: string;
  readonly hasUserEdited: boolean;
  readonly hasUnresolvedExplicitSource: boolean;
  readonly setBranchName: (next: string) => void;
  readonly selectSource: (next: string) => void;
}

/**
 * Resolves the selected source + the branch-name prefill. The
 * "edited" flag lives in state (not a ref) so an explicit source selection can
 * re-derive an untouched name while preserving a user-edited name. The render
 * adjustment handles source-option hydration and keeps a staged name intact.
 */
function useNewWorktreeFormState(
  model: UnifiedPickerModel,
  currentIntent: WorktreeFolderIntent | null,
  defaultNewBranchName: string,
): NewWorktreeFormState {
  const sourceOptions = model.sourceOptions;
  const [sourceId, setSourceId] = useState<string | null>(null);
  const selectedId = sourceId ?? model.newBranchSourceId;
  const selectedSource = useMemo(
    () =>
      sourceOptions.find((option) => option.id === selectedId) ??
      (selectedId === null && sourceOptions.length > 0
        ? sourceOptions[0]
        : null),
    [selectedId, sourceOptions],
  );
  const selectedSourceId = selectedSource?.id ?? null;
  const hasUnresolvedExplicitSource =
    sourceId !== null && selectedSource === null;

  const [nameState, setNameState] = useState(() => ({
    value: initialNewBranchName(
      currentIntent,
      selectedSource,
      defaultNewBranchName,
    ),
    forSource: selectedSourceId,
    edited: false,
  }));
  if (
    !hasUnresolvedExplicitSource &&
    !nameState.edited &&
    nameState.forSource !== selectedSourceId
  ) {
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

  const setBranchName = useCallback(
    (next: string) =>
      setNameState((prev) => ({ ...prev, value: next, edited: true })),
    [],
  );
  const selectSource = useCallback(
    (next: string) => {
      setSourceId(next);
      const nextSource = sourceOptions.find((option) => option.id === next);
      setNameState((prev) => {
        if (prev.edited || prev.forSource === nextSource?.id) return prev;
        return {
          value: nextSource?.defaultNewBranchName ?? defaultNewBranchName,
          forSource: nextSource?.id ?? null,
          edited: false,
        };
      });
    },
    [defaultNewBranchName, sourceOptions],
  );

  return {
    selectedSource,
    branchName: nameState.value,
    hasUserEdited:
      nameState.edited ||
      (sourceId !== null && sourceId !== model.newBranchSourceId),
    hasUnresolvedExplicitSource,
    setBranchName,
    selectSource,
  };
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
