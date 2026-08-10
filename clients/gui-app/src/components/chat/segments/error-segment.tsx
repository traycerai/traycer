import { useCallback } from "react";
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
  // Built at CLICK time, never at render. This row is durable transcript: it
  // mounts whenever the chat is opened, which is one or more commits BEFORE
  // `SupportContextRegistryBridge`'s effects publish that chat's own
  // id/harness/model (chat state arrives through a store subscription, so it
  // trails a route change by two commits). Both `buildReportIssueDraftContext`
  // and `capturePersistedAgentError` snapshot that registry, and the harness
  // id doubles as the fingerprint's `causalProvider` - so building at render
  // would file the report under the PREVIOUSLY open chat and cluster it under
  // the wrong provider. Report time is the only moment the registry is known
  // to describe this row's chat. Deferring also keeps the draft honest when
  // the runtime accumulator replaces a same-blockId error under a MOUNTED row
  // (blockId is this row's React key) - the click reads today's props.
  //
  // The real message/code reach ONLY the private diagnostics branch - the
  // public prefill stays null-bodied because both fields are host/harness-
  // supplied free text and the public context does no redaction (see the
  // hostile transcript-code test).
  const buildReportContext = useCallback(
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
          context={buildReportContext}
          presentation="icon"
          className="-mt-1 -mr-1 shrink-0"
        />
      </div>
    </div>
  );
}
