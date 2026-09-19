import { useCallback, type ReactNode } from "react";
import { ListChecks, Paintbrush, Trash2, X } from "lucide-react";
import { RefreshIcon } from "@/components/refresh-icon";
import { Button } from "@/components/ui/button";
import { EpicsSortMenu } from "@/components/epics/epics-sort-menu";
import { EpicsFilterPopover } from "@/components/epics/epics-filter-popover";
import type {
  HistorySortOption,
  HistoryWorkspaceRef,
} from "@/components/home/data/home-page.data";
import type { HistoryFacets } from "@/hooks/home/use-history-query";
import type {
  HistorySearchPatch,
  HistorySearchState,
} from "@/lib/history-search";
import { useRefreshSpinner } from "@/hooks/use-refresh-spinner";

const HISTORY_REFRESH_TIMEOUT_MS = 10_000;

interface PanelFilterControls {
  readonly active: boolean;
  readonly onClear: () => void;
}

type PanelSelectionControls =
  | {
      readonly kind: "idle";
      readonly canSelect: boolean;
      readonly onStart: () => void;
    }
  | {
      readonly kind: "active";
      readonly canSelect: boolean;
      readonly selectedCount: number;
      readonly allVisibleSelected: boolean;
      readonly isDeletePending: boolean;
      /** At least one selected task owns a worktree the dialog could list. */
      readonly canSweepSelected: boolean;
      readonly onSelectAll: () => void;
      readonly onDeselectAll: () => void;
      readonly onCancel: () => void;
      readonly onDeleteSelected: () => void;
      readonly onSweepSelected: () => void;
    };

interface PanelRefreshControls {
  readonly isFetching: boolean;
  readonly hostId: string | null;
  readonly onRefetch: () => void | Promise<unknown>;
}

export interface HistoryTaskControlsProps {
  readonly filters: PanelFilterControls;
  /** False for the read-only `variant="picker"` embed: hides the entry point
   * into bulk select/sweep/delete rather than merely disabling it. */
  readonly showSelection: boolean;
  readonly selection: PanelSelectionControls;
  readonly sort: HistorySortOption;
  readonly onSortChange: (next: HistorySortOption) => void;
  readonly availableRepos: ReadonlyArray<string>;
  readonly availableWorkspaces: ReadonlyArray<HistoryWorkspaceRef>;
  readonly search: HistorySearchState;
  readonly onSearchChange: (patch: HistorySearchPatch) => void;
  readonly facets: HistoryFacets | undefined;
  readonly chatHostFilterSupported: boolean;
  readonly refresh: PanelRefreshControls;
}

export function HistoryTaskControls(
  props: HistoryTaskControlsProps,
): ReactNode {
  const { isFetching, hostId, onRefetch } = props.refresh;
  const refreshTasks = useCallback(async () => {
    await onRefetch();
  }, [onRefetch]);
  const refresh = useRefreshSpinner({
    onRefresh: refreshTasks,
    externalRefreshing: isFetching,
    timeoutMs: HISTORY_REFRESH_TIMEOUT_MS,
  });

  return (
    <div className="flex min-w-0 grow flex-wrap items-center justify-end gap-1">
      {props.selection.kind === "active" ? (
        <ActiveSelectionControls selection={props.selection} />
      ) : (
        // Paired sub-groups so a wrap breaks between pairs instead of
        // orphaning a lone icon on its own line. Intra- and inter-group
        // gaps are both gap-1, so the one-line rendering is unchanged.
        <>
          <div className="flex shrink-0 items-center gap-1">
            <EpicsSortMenu value={props.sort} onChange={props.onSortChange} />
            <EpicsFilterPopover
              availableRepos={props.availableRepos}
              availableWorkspaces={props.availableWorkspaces}
              search={props.search}
              onSearchChange={props.onSearchChange}
              facets={props.facets}
              chatHostFilterSupported={props.chatHostFilterSupported}
            />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {props.showSelection ? (
              <Button
                type="button"
                variant="muted"
                size="sm"
                aria-label="Select history items"
                disabled={!props.selection.canSelect}
                className="overflow-visible"
                onClick={props.selection.onStart}
              >
                <ListChecks className="size-4" />
                Select
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh tasks"
              data-testid="epics-list-refresh"
              disabled={refresh.refreshing || hostId === null}
              onClick={refresh.trigger}
            >
              <RefreshIcon refreshing={refresh.refreshing} />
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function ActiveSelectionControls(props: {
  readonly selection: Extract<
    PanelSelectionControls,
    { readonly kind: "active" }
  >;
}): ReactNode {
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={!props.selection.canSelect}
        onClick={
          props.selection.allVisibleSelected
            ? props.selection.onDeselectAll
            : props.selection.onSelectAll
        }
      >
        {props.selection.allVisibleSelected ? "Deselect all" : "Select all"}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={props.selection.onCancel}
      >
        <X />
        Cancel
      </Button>
      <Button
        type="button"
        variant="muted"
        size="icon-sm"
        aria-label={
          props.selection.selectedCount > 0
            ? `Sweep worktrees for ${props.selection.selectedCount} selected tasks`
            : "Sweep worktrees for selected tasks"
        }
        aria-haspopup="dialog"
        data-testid="epics-list-sweep-selected"
        disabled={!props.selection.canSweepSelected}
        onClick={props.selection.onSweepSelected}
      >
        <Paintbrush />
      </Button>
      <Button
        type="button"
        variant="destructive-ghost"
        size="icon-sm"
        aria-label={
          props.selection.selectedCount > 0
            ? `Delete ${props.selection.selectedCount} selected epics`
            : "Delete selected epics"
        }
        data-testid="epics-list-delete-selected"
        disabled={
          props.selection.selectedCount === 0 || props.selection.isDeletePending
        }
        onClick={props.selection.onDeleteSelected}
      >
        <Trash2 />
      </Button>
    </>
  );
}
