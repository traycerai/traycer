import { Plus } from "lucide-react";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";

const NEW_TAB_PLACEHOLDER = "Start Page";

interface TabStripNewButtonProps {
  readonly onNewTab: () => void;
}

export function TabStripNewButton(
  props: TabStripNewButtonProps,
): React.ReactNode {
  const { onNewTab } = props;

  return (
    <TooltipWrapper
      label="New task"
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <button
        type="button"
        data-testid="tab-new"
        aria-label={NEW_TAB_PLACEHOLDER}
        onClick={onNewTab}
        className="ml-1 flex size-7 shrink-0 items-center justify-center self-center rounded-md text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground [-webkit-app-region:no-drag]"
      >
        <Plus className="size-4" />
      </button>
    </TooltipWrapper>
  );
}
