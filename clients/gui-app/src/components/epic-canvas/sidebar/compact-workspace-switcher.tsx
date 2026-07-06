import type { ReactNode } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { WorktreePickerTrigger } from "@/components/worktree/worktree-picker-trigger";

export interface CompactWorkspaceSwitcherProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly worktreeLabel: string;
  readonly secondaryLabel: string;
  readonly triggerClassName: string | undefined;
  readonly contentClassName: string | undefined;
  readonly triggerTestId: string;
  readonly contentTestId: string;
  readonly children: ReactNode;
}

export function CompactWorkspaceSwitcher(props: CompactWorkspaceSwitcherProps) {
  return (
    <Popover open={props.open} onOpenChange={props.onOpenChange}>
      <PopoverTrigger asChild>
        <WorktreePickerTrigger
          worktreeLabel={props.worktreeLabel}
          secondaryLabel={props.secondaryLabel}
          changeCount={null}
          trailingStatus={null}
          testId={props.triggerTestId}
          className={props.triggerClassName}
          aria-haspopup="listbox"
          aria-expanded={props.open}
        />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className={props.contentClassName}
        data-testid={props.contentTestId}
      >
        {props.children}
      </PopoverContent>
    </Popover>
  );
}
