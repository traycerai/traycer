/**
 * Workspace picker for the file-tree panel. Its popover shares the same
 * building blocks as the git diff and terminal pickers - an editable
 * `WorktreePickerHostSection` (selecting a host swaps the app-wide
 * default host, which is this panel's scope, so the `[epicId, hostId]`
 * selection and folder query re-resolve automatically) above the flat
 * searchable `WorktreeFolderList`.
 *
 * Data comes from the epic binding list so the file tree shows the same
 * chat/terminal-agent workspace set as terminals and git diff. The picker does
 * NOT expose "Add folder…" (file-tree is a consumer, not a folder editor -
 * folder management lives on the home / chat surfaces).
 *
 * Selection state is owned by `useFileTreeStore` keyed by
 * `[epicId, hostId]` so multi-host users keep distinct selections.
 */
import { useMemo, useState } from "react";
import type { WorktreeBindingSelectorRowV12 } from "@traycer/protocol/host";
import { useWorktreeListBindingsForEpic } from "@/hooks/worktree/use-worktree-list-bindings-for-epic-query";
import { WorktreeFolderListBody } from "@/components/worktree/worktree-folder-list-body";
import { WorktreePickerHostSection } from "@/components/worktree/worktree-picker-host-section";
import { formatGitWorktreeLabel } from "@/lib/git/worktree-label";
import { workspaceFolderName } from "@/lib/worktree/workspace-folder-name";
import { CompactWorkspaceSwitcher } from "@/components/epic-canvas/sidebar/compact-workspace-switcher";

export interface FileTreeWorkspacePickerProps {
  readonly epicId: string;
  readonly hostId: string | null;
  readonly selectedPath: string | null;
  readonly onSelectPath: (path: string) => void;
}

export function FileTreeWorkspacePicker(props: FileTreeWorkspacePickerProps) {
  // Controlled so a folder/worktree pick closes the popover. Left
  // uncontrolled, the popover stays open over the file tree after a
  // selection - the first click on a tree row then only dismisses the
  // popover instead of opening the file.
  const [open, setOpen] = useState(false);
  const listQuery = useWorktreeListBindingsForEpic({
    epicId: props.epicId,
    enabled: props.hostId !== null,
  });
  const rows = useMemo(
    () => listQuery.data?.rows ?? [],
    [listQuery.data?.rows],
  );
  const selectedRow =
    rows.find((row) => row.runningDir === props.selectedPath) ?? null;

  const selectedRoot = selectedWorkspaceRoot(rows, props.selectedPath);
  const triggerWorktreeLabel =
    selectedRow === null
      ? (selectedRoot?.folderName ?? "Select workspace")
      : formatGitWorktreeLabel(selectedRow);
  const triggerSecondaryLabel =
    props.selectedPath ?? "Choose a workspace folder";

  return (
    <CompactWorkspaceSwitcher
      open={open}
      onOpenChange={setOpen}
      worktreeLabel={triggerWorktreeLabel}
      secondaryLabel={triggerSecondaryLabel}
      triggerClassName={undefined}
      triggerTestId="file-tree-workspace-picker-trigger"
      contentClassName="w-[min(90vw,28rem)] gap-0 p-0"
      contentTestId="file-tree-workspace-picker-popover"
    >
      <WorktreePickerHostSection />
      <WorktreeFolderListBody
        isPending={listQuery.isPending}
        isError={listQuery.isError}
        rows={rows}
        selectedRow={selectedRow}
        // Secondary line per row = its full path, preserving the path info
        // the previous folder-row UI showed.
        secondaryLabel={(row) => row.runningDir}
        onSelect={(row) => {
          props.onSelectPath(row.runningDir);
          setOpen(false);
        }}
        autoFocusSearch={false}
        emptyMessage="No worktrees found."
      />
    </CompactWorkspaceSwitcher>
  );
}

interface SelectedWorkspaceRoot {
  readonly folderName: string;
}

function selectedWorkspaceRoot(
  rows: ReadonlyArray<WorktreeBindingSelectorRowV12>,
  selectedPath: string | null,
): SelectedWorkspaceRoot | null {
  if (selectedPath === null) return null;
  const row = rows.find((candidate) => candidate.runningDir === selectedPath);
  if (row !== undefined) {
    return {
      folderName: workspaceFolderName(row.workspacePath),
    };
  }
  return { folderName: workspaceFolderName(selectedPath) };
}
