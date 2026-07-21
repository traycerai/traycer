import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import {
  copyTerminalCommand,
  fixActionLabel,
  severityBadgeClass,
  severityBorderClass,
} from "@/components/settings/panels/host-doctor-actions";
import { modLabel } from "@/lib/keybindings/platform";
import { cn } from "@/lib/utils";
import type { HostDoctorIssue } from "@traycer-clients/shared/platform/runner-host";

interface HostDoctorIssueCardProps {
  readonly issue: HostDoctorIssue;
  readonly expanded: boolean;
  readonly recurrenceLocked: boolean;
  readonly fixPendingCode: string | null;
  readonly onFix: (issue: HostDoctorIssue) => void;
  readonly onToggle: (code: string) => void;
}

export function HostDoctorIssueCard(props: HostDoctorIssueCardProps) {
  const { issue, expanded, recurrenceLocked, fixPendingCode, onFix, onToggle } =
    props;
  const issueFixPending = fixPendingCode === issue.code;
  return (
    <div
      className={cn(
        "rounded-lg border bg-card/60 p-3",
        severityBorderClass(issue.severity),
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "mt-1 inline-flex size-5 items-center justify-center rounded-full text-ui-xs font-bold text-background",
            severityBadgeClass(issue.severity),
          )}
        >
          !
        </div>
        <div className="min-w-0 flex-1">
          <div className="break-words font-medium">{issue.title}</div>
          <div className="break-words text-ui-sm text-muted-foreground">
            {issue.message}
          </div>
          <div className="mt-2 flex max-w-full flex-wrap items-center gap-2">
            {issue.fixAction !== null ? (
              <Button
                variant="default"
                size="sm"
                disabled={recurrenceLocked || fixPendingCode !== null}
                onClick={() => onFix(issue)}
              >
                {issueFixPending ? (
                  <AgentSpinningDots
                    className="mr-2 size-3"
                    testId={undefined}
                    variant={undefined}
                  />
                ) : null}
                {fixActionLabel(issue.fixAction)}
              </Button>
            ) : null}
            {issue.terminalCommand !== null ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => copyTerminalCommand(issue.terminalCommand ?? "")}
              >
                {modLabel()} Open in Terminal
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onToggle(issue.code)}
            >
              {expanded ? "Hide details" : "Show details"}
            </Button>
          </div>
          {expanded && issue.terminalCommand !== null ? (
            <pre
              data-testid="host-doctor-issue-terminal-command"
              className="mt-2 max-h-40 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-code-xs text-muted-foreground"
            >
              {issue.terminalCommand}
            </pre>
          ) : null}
          {expanded && issue.details !== null ? (
            <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-code-xs text-muted-foreground">
              {JSON.stringify(issue.details, null, 2)}
            </pre>
          ) : null}
        </div>
      </div>
    </div>
  );
}
