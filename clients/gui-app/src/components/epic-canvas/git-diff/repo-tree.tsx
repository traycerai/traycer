import {
  useCallback,
  useMemo,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { FolderGit2, GitBranch, TriangleAlert } from "lucide-react";
import type { WorktreeBindingSelectorRow } from "@traycer/protocol/host";
import type { RepoTreeSubmoduleNode } from "@/lib/git/git-repo-tree";
import type { GitPanelSelectedRepo } from "@/stores/epics/git-panel-store";
import { getBasename } from "@/lib/path/cross-platform-path";
import { cn } from "@/lib/utils";

export interface RepoTreeRootRow {
  readonly row: WorktreeBindingSelectorRow;
  /** Parent working-tree change count from the v1.0 cache; null when unknown. */
  readonly changeCount: number | null;
  /**
   * Why this binding cannot be selected ("not git", setup states), or null for
   * a selectable git root. Disabled rows still render - greyed with the reason
   * - so a bound folder never silently vanishes from the panel.
   */
  readonly disabledLabel: string | null;
}

export interface RepoTreeProps {
  readonly roots: ReadonlyArray<RepoTreeRootRow>;
  readonly selected: GitPanelSelectedRepo;
  /** Submodule nodes of the active (selected) root only - bounded fan-out. */
  readonly activeRootSubmodules: ReadonlyArray<RepoTreeSubmoduleNode>;
  readonly onSelectRoot: (row: WorktreeBindingSelectorRow) => void;
  readonly onSelectSubmodule: (node: RepoTreeSubmoduleNode) => void;
}

type VisibleRow =
  | {
      readonly kind: "root";
      readonly key: string;
      readonly row: WorktreeBindingSelectorRow;
      readonly changeCount: number | null;
      readonly disabledLabel: string | null;
      readonly selected: boolean;
      readonly hasChildren: boolean;
    }
  | {
      readonly kind: "submodule";
      readonly key: string;
      readonly node: RepoTreeSubmoduleNode;
      readonly selected: boolean;
    };

function rootLabel(row: WorktreeBindingSelectorRow): string {
  return row.repoIdentifier?.repo ?? getBasename(row.runningDir);
}

/** Target index for the vertical/boundary nav keys, or null for other keys. */
function verticalKeyTarget(
  key: string,
  index: number,
  count: number,
): number | null {
  if (key === "ArrowDown") return index + 1;
  if (key === "ArrowUp") return index - 1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/** Index of the root row that owns the submodule row at `index` (else itself). */
function parentRootIndex(
  visibleRows: ReadonlyArray<VisibleRow>,
  index: number,
): number {
  const parentIndex = visibleRows
    .slice(0, index)
    .findLastIndex((r) => r.kind === "root");
  return parentIndex === -1 ? index : parentIndex;
}

/**
 * The bespoke repo tree: `root repo -> nested submodule(s)`, absorbing the old
 * worktree picker. Every root binding is a top-level node; only the active
 * (selected) root is expanded, showing its submodule child nodes (bounded lazy
 * fan-out - the panel fetches the nested `@1.1` snapshot for that root alone).
 *
 * Selecting a node scopes the single full-featured changes view. Standard tree
 * a11y: `role="tree"` on the container, `role="treeitem"` on each row with
 * `aria-level` / `aria-selected` / `aria-expanded`, a single roving `tabindex=0`
 * on the selected row, and Up/Down/Home/End/Right/Left keyboard navigation. Rows
 * are inlined (not child components) so the row-ref callback never flows through
 * a child's props.
 */
export function RepoTree(props: RepoTreeProps): ReactNode {
  const { roots, selected, activeRootSubmodules } = props;

  const visibleRows = useMemo<ReadonlyArray<VisibleRow>>(
    () =>
      roots.flatMap(({ row, changeCount, disabledLabel }) => {
        const isActiveRoot =
          row.hostId === selected.hostId &&
          row.runningDir === selected.rootRunningDir;
        const hasChildren = isActiveRoot && activeRootSubmodules.length > 0;
        const rootRow: VisibleRow = {
          kind: "root",
          key: `root:${row.hostId}:${row.runningDir}`,
          row,
          changeCount,
          disabledLabel,
          selected: isActiveRoot && selected.repoRoot === row.runningDir,
          hasChildren,
        };
        // Only the active root is expanded, so only it contributes child rows.
        const submoduleRows: VisibleRow[] = isActiveRoot
          ? activeRootSubmodules.map((node) => ({
              kind: "submodule",
              key: `sub:${node.repoRoot}`,
              node,
              selected: selected.repoRoot === node.repoRoot,
            }))
          : [];
        return [rootRow, ...submoduleRows];
      }),
    [roots, selected, activeRootSubmodules],
  );

  // Positional row refs, written by each row's callback ref (and nulled on
  // unmount). Never reset during render - stale trailing entries are harmless
  // because focus is always clamped to the current visible-row count.
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const focusRow = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(index, visibleRows.length - 1));
      rowRefs.current[clamped]?.focus();
    },
    [visibleRows.length],
  );

  const activateRow = useCallback(
    (index: number) => {
      const target = visibleRows[index];
      if (target.kind === "root") {
        if (target.disabledLabel !== null) return;
        props.onSelectRoot(target.row);
      } else {
        props.onSelectSubmodule(target.node);
      }
    },
    [props, visibleRows],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
      const vertical = verticalKeyTarget(event.key, index, visibleRows.length);
      if (vertical !== null) {
        event.preventDefault();
        focusRow(vertical);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activateRow(index);
        return;
      }
      const row = visibleRows[index];
      if (event.key === "ArrowRight" && row.kind === "root") {
        event.preventDefault();
        if (row.hasChildren) {
          // Expanded root: move focus to its first child (the next row).
          focusRow(index + 1);
        } else {
          // Collapsed root: expand it (== selecting it as the active root).
          activateRow(index);
        }
        return;
      }
      if (event.key === "ArrowLeft" && row.kind === "submodule") {
        // From a submodule, move focus up to its parent root.
        event.preventDefault();
        focusRow(parentRootIndex(visibleRows, index));
      }
      // ArrowLeft on a root is a no-op: roots are top-level (no parent) and
      // expansion is tied to selection, so there is no independent collapse.
    },
    [activateRow, focusRow, visibleRows],
  );

  // Roving tabindex: the selected row is the single tab stop; if the selection is
  // somehow not in the visible set, fall back to the first row.
  const tabbableIndex = useMemo(() => {
    const selectedIndex = visibleRows.findIndex((row) => row.selected);
    return selectedIndex === -1 ? 0 : selectedIndex;
  }, [visibleRows]);

  return (
    <div
      role="tree"
      aria-label="Repositories"
      className="flex max-h-[min(40vh,16rem)] shrink-0 flex-col overflow-y-auto border-b border-border/60 py-0.5"
      data-testid="git-repo-tree"
    >
      {visibleRows.map((row, index) => {
        const isDisabled = row.kind === "root" && row.disabledLabel !== null;
        return (
          <button
            key={row.key}
            ref={(element) => {
              rowRefs.current[index] = element;
            }}
            type="button"
            role="treeitem"
            aria-level={row.kind === "root" ? 1 : 2}
            aria-selected={row.selected}
            aria-expanded={
              row.kind === "root" && row.hasChildren ? true : undefined
            }
            aria-disabled={isDisabled ? true : undefined}
            tabIndex={index === tabbableIndex ? 0 : -1}
            onClick={() => activateRow(index)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={cn(
              "group flex min-h-6 w-full items-center gap-1.5 text-left text-ui-sm transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              row.kind === "root" ? "px-2" : "pr-2 pl-6",
              row.selected
                ? "bg-accent text-accent-foreground"
                : "hover:bg-accent/50",
              isDisabled && "cursor-default opacity-50 hover:bg-transparent",
              row.kind === "submodule" &&
                !row.node.hasChanges &&
                !row.node.unavailable &&
                !row.selected &&
                "opacity-60",
            )}
            data-testid={
              row.kind === "root"
                ? `git-repo-tree-root-${rootLabel(row.row)}`
                : `git-repo-tree-submodule-${row.node.parentPath}`
            }
          >
            {row.kind === "root" ? (
              <RootRowContent
                row={row.row}
                changeCount={row.changeCount}
                disabledLabel={row.disabledLabel}
              />
            ) : (
              <SubmoduleRowContent node={row.node} />
            )}
          </button>
        );
      })}
    </div>
  );
}

function RootRowContent(props: {
  readonly row: WorktreeBindingSelectorRow;
  readonly changeCount: number | null;
  readonly disabledLabel: string | null;
}): ReactNode {
  return (
    <>
      <FolderGit2
        className="size-3.5 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <span className="min-w-0 shrink truncate font-medium">
        {rootLabel(props.row)}
      </span>
      {props.row.branch !== null ? (
        <span className="min-w-0 flex-1 truncate text-ui-xs text-muted-foreground">
          {props.row.branch}
        </span>
      ) : (
        <span className="flex-1" aria-hidden />
      )}
      {props.disabledLabel !== null ? (
        <span className="shrink-0 text-ui-xs text-muted-foreground">
          {props.disabledLabel}
        </span>
      ) : (
        <ChangeCount count={props.changeCount} />
      )}
    </>
  );
}

function SubmoduleRowContent(props: {
  readonly node: RepoTreeSubmoduleNode;
}): ReactNode {
  const { node } = props;
  return (
    <>
      {node.unavailable ? (
        <TriangleAlert className="size-3.5 shrink-0 text-warning" aria-hidden />
      ) : (
        <GitBranch
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden
        />
      )}
      <span className="min-w-0 flex-1 truncate">{node.label}</span>
      {node.unavailable ? (
        <span className="shrink-0 text-ui-xs text-warning">unavailable</span>
      ) : (
        <>
          {node.hasChanges ? (
            <span
              className="size-1.5 shrink-0 rounded-full bg-warning"
              aria-hidden
            />
          ) : null}
          <ChangeCount count={node.changeCount} />
        </>
      )}
    </>
  );
}

function ChangeCount(props: { readonly count: number | null }): ReactNode {
  if (props.count === null || props.count === 0) return null;
  return (
    <span className="shrink-0 text-ui-xs tabular-nums text-muted-foreground">
      {props.count}
    </span>
  );
}
