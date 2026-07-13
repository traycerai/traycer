import { useMemo, useState, type ReactNode } from "react";
import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, FolderOpen } from "lucide-react";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { LogLevelRow } from "@/components/settings/panels/log-level-row";
import { Button } from "@/components/ui/button";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { CopyTextButton } from "@/components/copy-text-button";
import { useRunnerHost } from "@/providers/use-runner-host";
import { resolveDesktopSupportBridge } from "@/lib/windows/desktop-capabilities";
import { getLogLevelsBridge } from "@/lib/desktop-log-levels";
import {
  runnerMutationKeys,
  runnerQueryKeys,
} from "@/lib/query-keys/runner-mutation-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import type {
  DesktopSupportBridge,
  DesktopSupportLogDescriptor,
  DesktopSupportLogTailResult,
  DesktopSupportSnapshot,
} from "@/lib/windows/types";

const LOG_TAIL_LINES = 100;
const PANEL_DESCRIPTION =
  "Log verbosity for each Traycer component on this machine, plus recent log output. All default to Info — raise a level to Debug when capturing a problem for support, then set it back.";

export function DiagnosticsSettingsPanel() {
  // Every part of this panel (config + log files) is desktop-only; on the web
  // shell there is no bridge to read or write through.
  if (getLogLevelsBridge() === null) {
    return (
      <SettingsPanelShell title="Diagnostics" description={PANEL_DESCRIPTION}>
        <div className="px-5 py-6 text-ui-sm text-muted-foreground">
          Log configuration is only available on the desktop app.
        </div>
      </SettingsPanelShell>
    );
  }

  return (
    <SettingsPanelShell title="Diagnostics" description={PANEL_DESCRIPTION}>
      <LogLevelRow
        scope="desktop"
        label="App log level"
        description="Verbosity of the desktop app's own logs."
      />
      <LogLevelRow
        scope="cli"
        label="CLI log level"
        description="Verbosity of the bundled Traycer CLI's logs."
      />
      <LogLevelRow
        scope="host"
        label="Host log level"
        description="Verbosity of the background host process's logs."
      />
      <DiagnosticsLogs />
    </SettingsPanelShell>
  );
}

function DiagnosticsLogs(): ReactNode {
  const runnerHost = useRunnerHost();
  const support = useMemo(
    () => resolveDesktopSupportBridge(runnerHost),
    [runnerHost],
  );

  const listQuery = useQuery(
    queryOptions<DesktopSupportSnapshot>({
      queryKey: runnerQueryKeys.supportLogList(support),
      queryFn: () => {
        if (support === null) throw new Error("Logs unavailable.");
        return support.getSnapshot();
      },
      enabled: support !== null,
      staleTime: 60_000,
    }),
  );

  if (support === null) return null;

  return (
    <>
      <div className="border-b border-border/40 px-5 py-4 last:border-b-0">
        <div className="font-medium text-foreground">Logs</div>
        <p className="text-ui-sm text-muted-foreground">
          Recent output from each log file. Expand to view the last{" "}
          {LOG_TAIL_LINES} lines, or reveal the file on disk.
        </p>
      </div>
      <DiagnosticsLogList
        pending={listQuery.isPending}
        error={listQuery.isError}
        logs={listQuery.data?.logs ?? []}
        support={support}
      />
    </>
  );
}

function DiagnosticsLogList(props: {
  readonly pending: boolean;
  readonly error: boolean;
  readonly logs: readonly DesktopSupportLogDescriptor[];
  readonly support: DesktopSupportBridge;
}): ReactNode {
  if (props.pending) {
    return <LogInfoLine>Loading logs…</LogInfoLine>;
  }
  if (props.error) {
    return <LogInfoLine>Couldn&apos;t load log details.</LogInfoLine>;
  }
  return (
    <>
      {props.logs.map((entry) => (
        <DiagnosticsLogEntry
          key={entry.target}
          entry={entry}
          support={props.support}
        />
      ))}
    </>
  );
}

function LogInfoLine(props: { readonly children: ReactNode }): ReactNode {
  return (
    <div className="px-5 py-4 text-ui-sm text-muted-foreground">
      {props.children}
    </div>
  );
}

function DiagnosticsLogEntry(props: {
  readonly entry: DesktopSupportLogDescriptor;
  readonly support: DesktopSupportBridge;
}): ReactNode {
  const { entry, support } = props;
  const [open, setOpen] = useState(false);

  const tailQuery = useQuery(
    queryOptions<DesktopSupportLogTailResult>({
      queryKey: runnerQueryKeys.supportLogTail(support, entry.target),
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

  const Chevron = open ? ChevronUp : ChevronDown;

  const lines = tailQuery.isSuccess ? tailQuery.data.lines : [];
  const copyValue = lines.join("\n");
  let tailText = "Loading log output…";
  if (tailQuery.isError) {
    tailText = "Couldn't load log output.";
  } else if (tailQuery.isSuccess) {
    tailText = lines.length === 0 ? "Log file is empty." : copyValue;
  }

  return (
    <div className="border-b border-border/40 px-5 py-4 last:border-b-0">
      <div className="flex items-start justify-between gap-6">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          data-testid={`diagnostics-log-toggle-${entry.target}`}
        >
          <Chevron className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium text-foreground">
            {entry.label}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          {open ? (
            <CopyTextButton
              value={copyValue}
              label="Copy"
              ariaLabel={`Copy ${entry.label} log`}
              disabled={copyValue.length === 0}
            />
          ) : null}
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
        </div>
      </div>
      {open ? (
        <div className="mt-3 flex items-start gap-2">
          <pre
            className="max-h-52 min-w-0 flex-1 overflow-auto rounded-md border border-border/60 bg-muted/30 px-3 py-2 font-mono text-code-xs text-muted-foreground"
            data-testid={`diagnostics-log-output-${entry.target}`}
          >
            {tailText}
          </pre>
          {tailQuery.isError ? (
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
