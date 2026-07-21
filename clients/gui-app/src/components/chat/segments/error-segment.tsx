import { AlertTriangle } from "lucide-react";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";

interface ErrorSegmentProps {
  message: string;
  code: string | null;
  findUnitId: string | null;
}

// Static error row. Auth errors never reach here - they are suppressed at the
// projection layer (`suppressAuthErrors` in `rendered-messages.ts`) and surfaced
// live as the composer's re-auth banner instead.
export function ErrorSegment({ code, findUnitId, message }: ErrorSegmentProps) {
  return (
    <div
      data-chat-find-unit={findUnitId ?? undefined}
      className="flex w-full flex-col gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-ui-sm"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle
          className="mt-0.5 size-3.5 shrink-0 text-destructive"
          aria-hidden
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-overline font-semibold uppercase text-destructive">
              Error
            </span>
            {code !== null && code.length > 0 ? (
              <span className="rounded border border-destructive/30 bg-destructive/10 px-1 font-mono text-code-xs text-destructive">
                {code}
              </span>
            ) : null}
          </div>
          <span className="whitespace-pre-wrap break-words text-foreground/90">
            {message}
          </span>
        </div>
        <ReportIssueAction
          context={createReportIssueContext({
            title: "Agent error",
            message: null,
            code: null,
            source: "Chat",
          })}
          presentation="icon"
          className="-mt-1 -mr-1 shrink-0"
        />
      </div>
    </div>
  );
}
