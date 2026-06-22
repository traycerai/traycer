import { History } from "lucide-react";
import { useRouterState } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { isHistoryPath } from "@/stores/tabs/kinds/history";
import {
  useSystemOverlayActive,
  useSystemTabModalActions,
} from "@/stores/tabs/use-system-tab-modal";
import { cn } from "@/lib/utils";

/**
 * Header trigger that opens (or focuses) the History tab. Click =
 * `ensureHistoryTab` (singleton in the tabs store) + `navigate` to the
 * remembered or default path. Active styling matches the History tab
 * descriptor's `matchesPath`.
 */
export function HistoryButton() {
  const { openHistory } = useSystemTabModalActions();
  const historyOverlayActive = useSystemOverlayActive("history");
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isActive = isHistoryPath(pathname) || historyOverlayActive;
  const onClick = () => {
    openHistory();
  };
  return (
    <TooltipWrapper label="History" side="top" sideOffset={6} align={undefined}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="History"
        aria-haspopup="dialog"
        data-testid="history-button"
        onClick={onClick}
        className={cn(
          "text-muted-foreground hover:text-foreground",
          isActive && "bg-accent text-foreground hover:text-foreground",
        )}
      >
        <History className="size-4" />
      </Button>
    </TooltipWrapper>
  );
}
