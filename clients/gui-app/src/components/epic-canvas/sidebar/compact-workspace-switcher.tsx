import type { ReactNode } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { WorktreePickerTrigger } from "@/components/worktree/worktree-picker-trigger";
import { isHostSwitcherListInteraction } from "@/components/settings/host-scope/host-switcher-portal";

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
        // The host picker's list is a nested Radix popover: it portals OUTSIDE
        // this content, so every click in it arrives here as an interaction
        // from outside. Dismissing on those would close the panel the picker
        // exists to scope, and no host could ever be chosen from it.
        onInteractOutside={(event) => {
          if (isHostSwitcherListInteraction(event.target)) {
            event.preventDefault();
          }
        }}
      >
        {props.children}
      </PopoverContent>
    </Popover>
  );
}
