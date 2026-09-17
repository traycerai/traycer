import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { HostDoctorIssueCard } from "@/components/settings/panels/host-doctor-issue-card";
import { describeFreePortPrompt } from "@/components/settings/panels/host-doctor-actions";
import { RECURRENCE_THRESHOLD } from "@/components/settings/panels/host-doctor-model";
import type { RecurrenceState } from "@/components/settings/panels/host-doctor-recurrence";
import type {
  HostDoctorIssue,
  FreePortAndRestartInput,
} from "@traycer-clients/shared/platform/runner-host";

interface HostDoctorReportContentProps {
  readonly issues: readonly HostDoctorIssue[];
  readonly expandedCodes: ReadonlySet<string>;
  readonly recurrence: RecurrenceState;
  readonly reportFetching: boolean;
  readonly fixPendingCode: string | null;
  readonly logTail: string | null;
  readonly freePortPrompt: FreePortAndRestartInput | null;
  readonly freePortPending: boolean;
  readonly onFix: (issue: HostDoctorIssue) => void;
  readonly onToggleIssue: (code: string) => void;
  readonly onRerun: () => void;
  readonly onFreePortOpenChange: (open: boolean) => void;
  readonly onConfirmFreePort: () => void;
}

export function HostDoctorReportContent(props: HostDoctorReportContentProps) {
  const {
    issues,
    expandedCodes,
    recurrence,
    reportFetching,
    fixPendingCode,
    freePortPrompt,
    freePortPending,
    onFix,
    onToggleIssue,
    onRerun,
    onFreePortOpenChange,
    onConfirmFreePort,
  } = props;
  return (
    <div className="space-y-3">
      <div className="text-ui-sm text-muted-foreground">
        Diagnostics found {issues.length} issue
        {issues.length === 1 ? "" : "s"}.
      </div>
      {issues.map((issue) => (
        <div key={issue.code}>
          <HostDoctorIssueCard
            issue={issue}
            expanded={expandedCodes.has(issue.code)}
            recurrenceLocked={recurrence.locked}
            fixPendingCode={fixPendingCode}
            onFix={onFix}
            onToggle={onToggleIssue}
          />
          {issue.fixAction === "host-logs" && props.logTail !== null ? (
            <pre
              className="mt-2 max-h-52 overflow-auto rounded-md bg-foreground/5 p-2 font-mono text-code-xs text-muted-foreground"
              data-testid="host-doctor-log-tail"
            >
              {props.logTail.length === 0
                ? "This host's log is empty or no longer there."
                : props.logTail}
            </pre>
          ) : null}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        {recurrence.locked ? (
          <span className="min-w-0 flex-1 text-ui-sm text-destructive">
            Doctor paused after {RECURRENCE_THRESHOLD} failed fixes - re-run to
            retry.
          </span>
        ) : (
          <span className="min-w-0 flex-1 text-ui-xs text-muted-foreground">
            Failures this minute: {recurrence.failures.length}
          </span>
        )}
        <Button
          className="ml-auto"
          variant="secondary"
          size="sm"
          disabled={reportFetching}
          onClick={onRerun}
        >
          {reportFetching ? (
            <AgentSpinningDots
              className="mr-2 size-3"
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          Re-run Doctor
        </Button>
      </div>

      <ConfirmDestructiveDialog
        blockedReason={null}
        open={freePortPrompt !== null}
        onOpenChange={onFreePortOpenChange}
        title="Free port and restart?"
        description={describeFreePortPrompt(freePortPrompt)}
        cascadeSummary={null}
        actionLabel="Free port + restart"
        isPending={freePortPending}
        onConfirm={onConfirmFreePort}
      />
    </div>
  );
}
