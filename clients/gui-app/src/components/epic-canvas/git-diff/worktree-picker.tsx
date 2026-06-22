import { useCallback, useState } from "react";
import { queryOptions, useQueries } from "@tanstack/react-query";
import type {
  GitListChangedFilesResponse,
  WorktreeBindingSelectorRow,
} from "@traycer/protocol/host";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { WorktreeFolderList } from "@/components/worktree/worktree-folder-list";
import { WorktreePickerHostSection } from "@/components/worktree/worktree-picker-host-section";
import { useGitPrefetchWorktreeStatus } from "@/hooks/git/use-git-prefetch-worktree-status";
import { useGitPanelStore } from "@/stores/epics/git-panel-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import { formatGitWorktreeLabel } from "@/lib/git/worktree-label";
import { formatWorktreeFolderDisabledReason } from "@/lib/worktree/worktree-folder-disabled-reason";
import { worktreeRowKey } from "@/lib/worktree/worktree-row-key";
import { isGitSelectable } from "@/lib/worktree/worktree-git-selectable";
import { GitWorktreePickerTrigger } from "./git-worktree-picker-trigger";

export interface WorktreePickerProps {
  readonly epicId: string;
  readonly rows: ReadonlyArray<WorktreeBindingSelectorRow>;
  readonly selectedRow: WorktreeBindingSelectorRow | null;
}

export function WorktreePicker(props: WorktreePickerProps) {
  const { epicId, rows, selectedRow } = props;
  const [isOpen, setIsOpen] = useState(false);
  const prefetch = useGitPrefetchWorktreeStatus();
  const ignoreWhitespace = useSettingsStore(
    (s) => s.diffViewerPreferences.ignoreWhitespace,
  );
  const cachedStatusQueries = useQueries({
    queries: rows.map((row) =>
      queryOptions({
        queryKey: gitQueryKeys.listChangedFiles(
          row.hostId,
          row.runningDir,
          ignoreWhitespace,
        ),
        queryFn: (): Promise<GitListChangedFilesResponse | null> =>
          Promise.resolve(null),
        enabled: false,
        staleTime: Infinity,
      }),
    ),
  });
  const cachedStatusByRowKey = new Map(
    rows.map((row, index) => [
      worktreeRowKey(row),
      cachedStatusQueries[index]?.data ?? null,
    ]),
  );

  const triggerWorktreeLabel =
    selectedRow === null
      ? "Select worktree"
      : formatGitWorktreeLabel(selectedRow);
  const triggerSecondaryLabel =
    selectedRow === null
      ? "Choose a repository worktree"
      : selectedRow.runningDir;
  const selectedChangeCount =
    selectedRow === null
      ? null
      : readCachedChangeCount(selectedRow, cachedStatusByRowKey);

  const handleOpen = useCallback(
    (open: boolean) => {
      setIsOpen(open);
      if (!open) return;

      const selectedWorktreeKey =
        selectedRow === null ? null : worktreeRowKey(selectedRow);
      rows.forEach((row) => {
        if (
          !isGitSelectable(row) ||
          worktreeRowKey(row) === selectedWorktreeKey
        ) {
          return;
        }
        void prefetch({
          hostId: row.hostId,
          runningDir: row.runningDir,
          ignoreWhitespace,
        });
      });
    },
    [ignoreWhitespace, prefetch, rows, selectedRow],
  );

  const handleSelectRow = useCallback(
    (row: WorktreeBindingSelectorRow) => {
      useGitPanelStore.getState().setSelectedWorktree(epicId, {
        hostId: row.hostId,
        runningDir: row.runningDir,
      });
      setIsOpen(false);
    },
    [epicId],
  );

  return (
    <Popover open={isOpen} onOpenChange={handleOpen}>
      <PopoverTrigger asChild>
        <GitWorktreePickerTrigger
          worktreeLabel={triggerWorktreeLabel}
          secondaryLabel={triggerSecondaryLabel}
          changeCount={selectedChangeCount}
          testId="git-worktree-picker-trigger"
          aria-haspopup="listbox"
          aria-expanded={isOpen}
        />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(90vw,28rem)] gap-0 p-0"
        data-testid="git-worktree-picker-popover"
      >
        <WorktreePickerHostSection />
        <WorktreeFolderList
          rows={rows}
          selectedRow={selectedRow}
          secondaryLabel={(row) => row.runningDir}
          disabledLabel={gitDiffDisabledLabel}
          onSelect={handleSelectRow}
        />
      </PopoverContent>
    </Popover>
  );
}

function gitDiffDisabledLabel(row: WorktreeBindingSelectorRow): string | null {
  if (!row.isGitRepo) return "not git";
  return formatWorktreeFolderDisabledReason(row);
}

function readCachedChangeCount(
  row: WorktreeBindingSelectorRow,
  cachedStatusByRowKey: ReadonlyMap<string, GitListChangedFilesResponse | null>,
): number | null {
  const data = cachedStatusByRowKey.get(worktreeRowKey(row)) ?? null;
  if (data === null) return null;
  return data.files.length;
}
