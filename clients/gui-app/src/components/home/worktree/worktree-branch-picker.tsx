import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { WorktreeBranchPickerContent } from "@/components/home/worktree/worktree-branch-picker-content";
import type { WorktreeBranchPickerProps } from "@/components/home/worktree/worktree-branch-picker-model";
import { useWorktreeBranchPickerController } from "@/components/home/worktree/use-worktree-branch-picker-controller";

export type {
  WorktreeBranchPickerAction,
  WorktreeBranchPickerPinnedRow,
  WorktreeBranchPickerRow,
} from "@/components/home/worktree/worktree-branch-picker-model";

export function WorktreeBranchPicker(props: WorktreeBranchPickerProps) {
  const { trigger } = props;
  const controller = useWorktreeBranchPickerController(props);
  return (
    <Popover
      open={controller.open}
      onOpenChange={(next, details) => {
        if (
          !next &&
          details.reason === "escape-key" &&
          controller.contentProps.hasQuery
        ) {
          details.cancel();
          controller.contentProps.resetQuery();
          return;
        }
        controller.handleOpenChange(next);
      }}
    >
      <PopoverTrigger render={trigger} />
      <WorktreeBranchPickerContent {...controller.contentProps} />
    </Popover>
  );
}
