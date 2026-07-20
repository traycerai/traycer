import type { ReactNode } from "react";
import { Bug } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ReportIssueContext } from "@/lib/report-issue-context";
import { cn } from "@/lib/utils";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

interface ReportIssueActionProps {
  readonly context: ReportIssueContext;
  readonly presentation: "text" | "icon" | "link";
  readonly className: string | undefined;
}

export function ReportIssueAction(props: ReportIssueActionProps): ReactNode {
  const reportIssueAvailable = useDesktopDialogStore(
    (state) => state.reportIssueAvailable,
  );
  const openReportIssueWithContext = useDesktopDialogStore(
    (state) => state.openReportIssueWithContext,
  );
  if (!reportIssueAvailable) return null;

  const handleClick = () => {
    Analytics.getInstance().track(AnalyticsEvent.ReportIssueOpened, {
      source: "direct_ui",
    });
    openReportIssueWithContext(props.context);
  };

  if (props.presentation === "text") {
    return (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className={cn("text-muted-foreground", props.className)}
        onClick={handleClick}
      >
        <Bug aria-hidden />
        Report issue
      </Button>
    );
  }

  if (props.presentation === "link") {
    return (
      <Button
        type="button"
        size="xs"
        variant="link"
        className={props.className}
        onClick={handleClick}
      >
        Report issue
      </Button>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className={cn("text-muted-foreground", props.className)}
          aria-label="Report issue"
          onClick={handleClick}
        >
          <Bug aria-hidden />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Report issue</TooltipContent>
    </Tooltip>
  );
}
