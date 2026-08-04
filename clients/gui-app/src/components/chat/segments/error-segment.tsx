import { useMemo } from "react";
import { AlertTriangle } from "lucide-react";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { buildReportIssueDraftContext } from "@/lib/report-issue-draft-context";
import { capturePersistedAgentError } from "@/lib/report-issue-error-capture";

interface ErrorSegmentProps {
  message: string;
  code: string | null;
  recoverable: boolean;
  findUnitId: string | null;
}

// Static error row. Auth errors (`code: "auth"`) render here like any other
// error - the durable transcript row is what keeps a headless (A2A-triggered)
// auth failure visible after the composer's re-auth banner clears.
export function ErrorSegment({
  code,
  findUnitId,
  message,
  recoverable,
}: ErrorSegmentProps) {
  // Rebuilt when the row's fields change: the runtime accumulator replaces a
  // same-blockId error in place (message/code/recoverable), and the blockId is
  // this row's React key, so a MOUNTED row can update - a frozen draft would
  // report the old cause. Re-minting the correlation id/timestamp on rebuild
  // is fine (the capture has no external effect). The real message/code reach
  // ONLY the private diagnostics branch - the public prefill stays null-bodied
  // because both fields are host/harness-supplied free text and the public
  // context does no redaction (see the hostile transcript-code test).
  const reportContext = useMemo(
    () =>
      buildReportIssueDraftContext(
        createReportIssueContext({
          title: "Agent error",
          message: null,
          code: null,
          source: "Chat",
        }),
        capturePersistedAgentError({ message, code, recoverable }),
      ),
    [code, message, recoverable],
  );
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
          context={reportContext}
          presentation="icon"
          className="-mt-1 -mr-1 shrink-0"
        />
      </div>
    </div>
  );
}
