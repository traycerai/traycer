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
    <Popover open={controller.open} onOpenChange={controller.handleOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <WorktreeBranchPickerContent {...controller.contentProps} />
    </Popover>
  );
}
