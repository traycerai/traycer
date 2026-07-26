import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, FolderOpen, Info } from "lucide-react";
import { toast } from "sonner";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { SettingsGroup } from "@/components/settings/settings-group";
import { LogLevelRow } from "@/components/settings/panels/log-level-row";
import { Button } from "@/components/ui/button";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { CopyTextButton } from "@/components/copy-text-button";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useSettingsDensity } from "@/providers/settings-density-context";
import { cn } from "@/lib/utils";
import { resolveDesktopSupportBridge } from "@/lib/windows/desktop-capabilities";
import { useRunnerLogLevelsQuery } from "@/hooks/runner/use-runner-log-levels-query";
import { useRunnerLogLevelsSet } from "@/hooks/runner/use-runner-log-levels-set-mutation";
import {
  getLogLevelsBridge,
  selectScopeLevel,
  type LogLevelScope,
} from "@/lib/desktop-log-levels";
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
  "Log verbosity for each Traycer component on this machine, plus recent log output. All default to Info - raise a level to Debug when capturing a problem for support, then set it back.";
const LOG_LEVEL_SCOPES: readonly LogLevelScope[] = ["desktop", "cli", "host"];

export function DiagnosticsSettingsPanel() {
  const compact = useSettingsDensity() === "compact";

  return (
    <SettingsPanelShell
      title="Diagnostics"
      description={PANEL_DESCRIPTION}
      fillHeight
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      <div
        className={cn(
          "flex h-full min-h-0 flex-col",
          compact ? "gap-2.5" : "gap-3",
        )}
      >
        <LogDetailGroup />
        <RecentLogsSection />
      </div>
    </SettingsPanelShell>
  );
}

/**
 * App/CLI/Host verbosity controls. When any level differs from the Info
 * default, a quiet reminder + one-click "Reset all to Info" appear inside the
 * same group so raising detail for support never gets forgotten. Gates only
 * on the log-levels bridge - independent of the Recent logs support bridge,
 * so each unavailable state stays inside the group it affects instead of
 * hiding the other.
 */
function LogDetailGroup(): ReactNode {
  const levelsQuery = useRunnerLogLevelsQuery();
  const setLevelMutation = useRunnerLogLevelsSet();
  const [resetPending, setResetPending] = useState(false);
  // Focus-restoration target for when the reminder row (and the "Reset all to
  // Info" button a keyboard/screen-reader user just activated) unmounts -
  // without this, focus silently drops to `<body>`. Tracks the PRIOR
  // visibility so it only fires on the true->false transition, never on
  // initial mount (mirrors `host-settings-summary-card.tsx`'s
  // `wasEditingRef` pattern for the analogous "the focused control
  // disappears" case).
  const groupContentRef = useRef<HTMLDivElement>(null);
  const reminderWasVisibleRef = useRef(false);
  const reminderHadFocusRef = useRef(false);

  const snapshot = levelsQuery.data;
  const nonDefaultScopes = useMemo(() => {
    if (snapshot === undefined) return [];
    return LOG_LEVEL_SCOPES.filter(
      (scope) => selectScopeLevel(snapshot, scope) !== "info",
    );
  }, [snapshot]);

  useEffect(() => {
    const isVisible = nonDefaultScopes.length > 0;
    if (
      reminderWasVisibleRef.current &&
      !isVisible &&
      reminderHadFocusRef.current
    ) {
      groupContentRef.current?.focus();
    }
    if (!isVisible) {
      reminderHadFocusRef.current = false;
    }
    reminderWasVisibleRef.current = isVisible;
  }, [nonDefaultScopes.length]);

  const handleResetAll = async (): Promise<void> => {
    const scopes = nonDefaultScopes;
    setResetPending(true);
    let failedCount = 0;
    for (const scope of scopes) {
      try {
        await setLevelMutation.mutateAsync({ scope, level: "info" });
      } catch {
        // The mutation's own onError already toasted this scope - keep
        // going so one failure doesn't strand the remaining scopes
        // un-attempted and silently still elevated.
        failedCount += 1;
      }
    }
    setResetPending(false);
    if (failedCount > 0 && scopes.length > 1) {
      toast.error(
        `Couldn't reset ${failedCount} of ${scopes.length} log level${scopes.length === 1 ? "" : "s"}`,
      );
    }
  };

  if (getLogLevelsBridge() === null) {
    return (
      <SettingsGroup
        title="Log detail"
        tone="default"
        dataTestId={undefined}
        fill={false}
      >
        <LogInfoLine>
          Log level controls are only available on the desktop app.
        </LogInfoLine>
      </SettingsGroup>
    );
  }

  return (
    <SettingsGroup
      title="Log detail"
      tone="default"
      dataTestId={undefined}
      fill={false}
    >
      <div
        ref={groupContentRef}
        tabIndex={-1}
        className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <LogLevelRow
          scope="desktop"
          label="App log level"
          description="Verbosity of the desktop app's own logs."
          disabled={resetPending}
        />
        <LogLevelRow
          scope="cli"
          label="CLI log level"
          description="Verbosity of the bundled Traycer CLI's logs."
          disabled={resetPending}
        />
        <LogLevelRow
          scope="host"
          label="Host log level"
          description="Verbosity of the background host process's logs."
          disabled={resetPending}
        />
        {nonDefaultScopes.length > 0 ? (
          <TemporaryDebugReminderRow
            pending={resetPending}
            onFocusChange={(focused) => {
              reminderHadFocusRef.current = focused;
            }}
            onReset={() => {
              void handleResetAll();
            }}
          />
        ) : null}
      </div>
    </SettingsGroup>
  );
}

function TemporaryDebugReminderRow(props: {
  readonly pending: boolean;
  readonly onFocusChange: (focused: boolean) => void;
  readonly onReset: () => void;
}): ReactNode {
  const { pending, onFocusChange, onReset } = props;
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 bg-muted/20 px-4 py-2.5 text-ui-xs text-muted-foreground"
      data-testid="diagnostics-log-detail-reminder"
      onFocusCapture={() => onFocusChange(true)}
      onBlurCapture={(event) => {
        const nextFocusedElement = event.relatedTarget;
        if (
          !(nextFocusedElement instanceof Node) ||
          !event.currentTarget.contains(nextFocusedElement)
        ) {
          onFocusChange(false);
        }
      }}
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <Info className="size-3.5 shrink-0" aria-hidden />
        One or more levels differ from Info for troubleshooting. Reset when
        you&apos;re done.
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0"
        disabled={pending}
        onClick={onReset}
        data-testid="diagnostics-reset-log-levels"
      >
        {pending ? (
          <AgentSpinningDots
            className="text-current"
            testId={undefined}
            variant={undefined}
          />
        ) : null}
        Reset all to Info
      </Button>
    </div>
  );
}

/**
 * The evidence viewer: a quiet external label (mirrors the Notifications
 * "Notification hooks" manager label) followed by a content-sized card. The
 * card grows only as its rows need it, then caps at the section's remaining
 * height and becomes the page's primary scroll owner. Gates only on the
 * desktop support bridge - independent of the log-levels bridge Log detail
 * uses - and shows its own unavailable state inside the group rather than
 * disappearing when only this bridge is absent.
 */
function RecentLogsSection(): ReactNode {
  const runnerHost = useRunnerHost();
  const support = useMemo(
    () => resolveDesktopSupportBridge(runnerHost),
    [runnerHost],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5">
      <h2 className="shrink-0 px-1 font-semibold text-ui-xs text-muted-foreground">
        Recent logs · Last {LOG_TAIL_LINES} lines
      </h2>
      <div
        className="min-h-0 max-h-full overflow-y-auto rounded-lg border border-border/60 bg-card/40"
        data-testid="diagnostics-log-list"
      >
        {support === null ? (
          <LogInfoLine>
            Recent logs are only available on the desktop app.
          </LogInfoLine>
        ) : (
          <DiagnosticsLogs support={support} />
        )}
      </div>
    </div>
  );
}

function DiagnosticsLogs(props: {
  readonly support: DesktopSupportBridge;
}): ReactNode {
  const { support } = props;
  const listQuery = useQuery(
    queryOptions<DesktopSupportSnapshot>({
      queryKey: runnerQueryKeys.supportLogList(support),
      queryFn: () => support.getSnapshot(),
      staleTime: 60_000,
    }),
  );

  return (
    <div className="flex flex-col">
      <DiagnosticsLogList
        pending={listQuery.isPending}
        error={listQuery.isError}
        logs={listQuery.data?.logs ?? []}
        support={support}
      />
    </div>
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
  if (props.logs.length === 0) {
    return <LogInfoLine>No log files found.</LogInfoLine>;
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
    <div
      className="border-b border-border/40 px-5 py-4 last:border-b-0"
      data-testid={`diagnostics-log-entry-${entry.target}`}
    >
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
