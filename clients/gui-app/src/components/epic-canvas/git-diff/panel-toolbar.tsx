import type { WorktreeBindingSelectorRow } from "@traycer/protocol/host";
import { cn } from "@/lib/utils";
import { WorkspacePickerWithOpener } from "@/components/worktree/workspace-picker-with-opener";
import { WorktreePicker } from "./worktree-picker";

export interface PanelToolbarProps {
  readonly epicId: string;
  readonly rows: ReadonlyArray<WorktreeBindingSelectorRow>;
  readonly selectedRow: WorktreeBindingSelectorRow | null;
}

export function PanelToolbar(props: PanelToolbarProps) {
  return (
    <div className={cn("shrink-0 bg-background/50 px-2 pt-1.5 pb-1")}>
      <WorkspacePickerWithOpener
        picker={
          <WorktreePicker
            epicId={props.epicId}
            rows={props.rows}
            selectedRow={props.selectedRow}
          />
        }
        openTarget={
          props.selectedRow
            ? {
                workspacePath: props.selectedRow.runningDir,
                hostId: props.selectedRow.hostId,
              }
            : null
        }
      />
    </div>
  );
}
