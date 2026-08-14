import { useState, type ReactNode } from "react";
import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, FolderOpen } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { CopyTextButton } from "@/components/copy-text-button";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import {
  LOG_TAIL_LINES,
  type LogTailView,
} from "@/components/settings/panels/diagnostics-log-tail";
import {
  runnerMutationKeys,
  runnerQueryKeys,
  supportBridgeQueryScopeId,
} from "@/lib/query-keys/runner-mutation-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import type {
  DesktopSupportBridge,
  DesktopSupportLogDescriptor,
  DesktopSupportLogTailResult,
} from "@/lib/windows/types";

/**
 * The log-tail reader, shared by the two Diagnostics pages.
 *
 * There are two of them because a log has an OWNER: the app's own log describes
 * this window and follows you between hosts, while `host.log` / `cli.log`
 * describe whichever machine the sidebar picker names. They used to sit in one
 * list, which meant every host in the account rendered its own copy of the same
 * desktop log — the duplication this split removes.
 *
 * What did NOT split is the presentation. A log entry is a disclosure with a
 * tail and one action, whichever transport produced it, so the frame and the
 * bridge-backed entry live here and both pages render the same row.
 *
 * Components only — `LOG_TAIL_LINES`, `LogTailView` and the snapshot query live
 * in `diagnostics-log-tail.ts`, because a `.tsx` module that exports anything
 * else loses fast refresh for the whole file.
 */
export function LogInfoLine(props: {
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className="px-5 py-4 text-ui-sm text-muted-foreground">
      {props.children}
    </div>
  );
}

/**
 * The evidence viewer: a quiet external label (mirrors the Notifications
 * "Notification hooks" manager label) followed by a content-sized card. The
 * card grows only as its rows need it, then caps at the section's remaining
 * height and becomes the page's primary scroll owner.
 */
export function RecentLogsFrame(props: {
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5">
      <h2 className="shrink-0 px-1 font-semibold text-ui-xs text-muted-foreground">
        Recent logs · Last {LOG_TAIL_LINES} lines
      </h2>
      <div
        className="min-h-0 max-h-full overflow-y-auto rounded-lg border border-border/60 bg-card/40"
        data-testid="diagnostics-log-list"
      >
        {props.children}
      </div>
    </div>
  );
}

export function BridgeLogEntry(props: {
  readonly entry: DesktopSupportLogDescriptor;
  readonly support: DesktopSupportBridge;
}): ReactNode {
  const { entry, support } = props;
  const [open, setOpen] = useState(false);

  const tailQuery = useQuery(
    queryOptions<DesktopSupportLogTailResult>({
      queryKey: runnerQueryKeys.supportLogTail(
        supportBridgeQueryScopeId(support),
        entry.target,
      ),
      queryFn: () =>
        support.tailLog({ target: entry.target, tailLines: LOG_TAIL_LINES }),
      enabled: open,
      staleTime: 5_000,
    }),
  );

  const revealMutation = useMutation({
    mutationKey: runnerMutationKeys.revealLog(),
    mutationFn: () => support.revealLog(entry.target),
    onError: (error) =>
      toastFromRunnerError(error, "Couldn't open the log file"),
  });

  let tail: LogTailView = { status: "loading" };
  if (tailQuery.isError) {
    tail = { status: "error" };
  } else if (tailQuery.isSuccess) {
    tail = { status: "ready", lines: tailQuery.data.lines };
  }

  return (
    <DiagnosticsLogEntryFrame
      target={entry.target}
      label={entry.label}
      open={open}
      onToggle={() => setOpen((value) => !value)}
      tail={tail}
      action={
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={revealMutation.isPending}
          onClick={() => revealMutation.mutate()}
        >
          {revealMutation.isPending ? (
            <AgentSpinningDots
              className="text-current"
              testId={undefined}
              variant={undefined}
            />
          ) : (
            <FolderOpen />
          )}
          Reveal
        </Button>
      }
    />
  );
}

export function DiagnosticsLogEntryFrame(props: {
  readonly target: string;
  readonly label: string;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly tail: LogTailView;
  /** Reveal for a bridge-owned file, Copy path for a host-owned one. */
  readonly action: ReactNode;
}): ReactNode {
  const { target, label, open, tail } = props;
  const Chevron = open ? ChevronUp : ChevronDown;

  const lines = tail.status === "ready" ? tail.lines : [];
  const copyValue = lines.join("\n");
  let tailText = "Loading log output…";
  if (tail.status === "error") {
    tailText = "Couldn't load log output.";
  } else if (tail.status === "missing") {
    tailText = "This log file is no longer there.";
  } else if (tail.status === "ready") {
    tailText = lines.length === 0 ? "Log file is empty." : copyValue;
  }

  return (
    <div
      className="border-b border-border/40 px-5 py-4 last:border-b-0"
      data-testid={`diagnostics-log-entry-${target}`}
    >
      <div className="flex items-start justify-between gap-6">
        <button
          type="button"
          aria-expanded={open}
          onClick={props.onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          data-testid={`diagnostics-log-toggle-${target}`}
        >
          <Chevron className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium text-foreground">{label}</span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          {open ? (
            <CopyTextButton
              value={copyValue}
              label="Copy"
              ariaLabel={`Copy ${label} log`}
              disabled={copyValue.length === 0}
            />
          ) : null}
          {props.action}
        </div>
      </div>
      {open ? (
        <div className="mt-3 flex items-start gap-2">
          <pre
            className="max-h-[min(13rem,40vh)] min-w-0 flex-1 overflow-auto rounded-md border border-border/60 bg-muted/30 px-3 py-2 font-mono text-code-xs text-muted-foreground"
            data-testid={`diagnostics-log-output-${target}`}
          >
            {tailText}
          </pre>
          {tail.status === "error" ? (
            <ReportIssueAction
              context={createReportIssueContext({
                title: "Couldn't load log output",
                message: null,
                code: null,
                source: "Diagnostics",
              })}
              presentation="icon"
              className={undefined}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
