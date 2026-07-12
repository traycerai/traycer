import type { GitSubscribeStatusEvent } from "@traycer/protocol/host/git-schemas";
import { AlertCircle } from "lucide-react";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";

export interface SubscriptionErrorStateProps {
  readonly event: GitSubscribeStatusEvent;
}

export function SubscriptionErrorState(props: SubscriptionErrorStateProps) {
  const message =
    props.event.type === "error" ? props.event.message : "An error occurred";

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 text-center px-4 py-8">
      <AlertCircle className="size-8 text-destructive" />
      <div>
        <p className="text-sm font-medium text-foreground">Error</p>
        <p className="text-xs text-muted-foreground max-w-sm">{message}</p>
      </div>
      <ReportIssueAction
        context={createReportIssueContext({
          title: "Git subscription error",
          message: "The Git changes subscription failed.",
          code: null,
          source: "Git changes",
        })}
        presentation="text"
        className={undefined}
      />
    </div>
  );
}
