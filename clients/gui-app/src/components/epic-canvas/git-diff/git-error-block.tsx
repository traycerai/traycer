import { AlertTriangleIcon } from "lucide-react";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";

interface GitErrorBlockProps {
  readonly error: HostRpcError;
}

export function GitErrorBlock(props: GitErrorBlockProps) {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-6 text-center">
      <AlertTriangleIcon className="size-12 text-destructive" />
      <h3 className="text-base font-semibold">Diff Loading Error</h3>
      <p className="text-sm text-muted-foreground">
        {props.error.message || "An error occurred while loading the diff"}
      </p>
      <ReportIssueAction
        context={createReportIssueContext({
          title: "Diff loading error",
          message: "The Git diff could not be loaded.",
          code: props.error.code,
          source: "Git changes",
        })}
        presentation="text"
        className={undefined}
      />
    </div>
  );
}
