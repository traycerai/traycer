import { useMemo, useState, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { DiagnosticsLogTarget } from "@traycer/protocol/host/diagnostics/index";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import {
  HostConfigUnsupportedNotice,
  LocalConfigFallbackNotice,
} from "@/components/settings/host-scope/host-config-notices";
import {
  HostScopeConnecting,
  HostScopeGate,
} from "@/components/settings/host-scope/host-scope-gate";
import {
  localConfigFallbackReason,
  type LocalConfigFallbackReason,
} from "@/components/settings/host-scope/host-scope-model";
import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import { useScopedHostBinding } from "@/components/settings/host-scope/use-scoped-host-binding";
import {
  useHostScope,
  type HostScope,
} from "@/components/settings/host-scope/use-host-scope";
import { LogDetailGroup } from "@/components/settings/panels/diagnostics-log-detail-group";
import {
  BridgeLogEntry,
  DiagnosticsLogEntryFrame,
  LogInfoLine,
  RecentLogsFrame,
} from "@/components/settings/panels/diagnostics-log-entries";
import {
  LOG_TAIL_LINES,
  useSupportSnapshotQuery,
  type LogTailView,
} from "@/components/settings/panels/diagnostics-log-tail";
import {
  useBridgeHostLogLevelControls,
  useHostLogLevelControls,
} from "@/components/settings/panels/log-level-controls";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { CopyTextButton } from "@/components/copy-text-button";
import {
  useHostBinding,
  HostRuntimeContext,
  type HostRpcRegistry,
} from "@/lib/host";
import { useHostCapabilityProbe } from "@/hooks/host/use-host-capability-probe";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useSettingsDensity } from "@/providers/settings-density-context";
import { cn } from "@/lib/utils";
import { resolveDesktopSupportBridge } from "@/lib/windows/desktop-capabilities";
import type { DesktopSupportBridge } from "@/lib/windows/types";

const PANEL_DESCRIPTION =
  "Log verbosity and recent log output for the host selected above. Both levels default to Info - raise one to Debug when capturing a problem for support, then set it back. This app's own log and memory capture live under Application - Diagnostics.";
const LOG_LEVELS_GATE_METHOD = "config.logLevels.get";
const HOST_LOGS_GATE_METHOD = "diagnostics.logs.list";

/** The page carried three app-scoped surfaces as well - the `desktop` verbosity row, the heap capture, and this
 * window's own log tail - under a doc comment that called the mixed scope deliberate and stated it per row. */
export function DiagnosticsSettingsPanel() {
  const scope = useHostScope();
  // Nullable on purpose: `false` is a host that handshaked without the method; `null` is "no handshake yet", and
  // this page's own first RPC is what produces one.
  const levelsSupported = useHostMethodSupport(
    scope.hostId,
    LOG_LEVELS_GATE_METHOD,
  );
  const logsSupported = useHostMethodSupport(
    scope.hostId,
    HOST_LOGS_GATE_METHOD,
  );
  // Before the branch: hooks may not be conditional. Null for every scope that
  // is not an explicit, resolved pick.
  const scopedBinding = useScopedHostBinding(scope);
  // Keyed on the config family, the same one the Shell page uses - the two families ship in one host release, so
  // either answers "does this host predate the batch", and one predicate keeps the two pages consistent.
  const fallbackReason = localConfigFallbackReason(scope.host, levelsSupported);
  // The probe keeps the answer refutable; `scope.client` (never the ambient one) so it asks the host being
  // shown.
  useHostCapabilityProbe({
    client: scope.client,
    stale: levelsSupported === false || logsSupported === false,
    incarnation: [
      scope.host?.version ?? null,
      scope.host?.connectable ?? false,
    ],
  });

  if (fallbackReason !== null) {
    return (
      <DiagnosticsPanelOverLocalStore
        hostName={scope.hostLabel}
        reason={fallbackReason}
      />
    );
  }

  const inner = (
    <DiagnosticsPanelOverRpc
      scope={scope}
      levelsSupported={levelsSupported}
      logsSupported={logsSupported}
    />
  );
  if (scopedBinding === null) return inner;
  return (
    <HostRuntimeContext.Provider value={scopedBinding}>
      {inner}
    </HostRuntimeContext.Provider>
  );
}

function DiagnosticsPanelOverRpc(props: {
  readonly scope: HostScope;
  readonly levelsSupported: boolean | null;
  readonly logsSupported: boolean | null;
}) {
  const { scope, levelsSupported, logsSupported } = props;
  const compact = useSettingsDensity() === "compact";
  // Mounting, not rendering: a query hook mounted under a non-ready scope still fires against the ambient host
  // and caches its answer, however well the gate hides the result.
  const usable = isHostScopeUsable(scope.status);

  // The binding rather than `useHostClient`: same context, re-provided by the panel above for an explicit pick,
  // but `null` instead of a throw when there is no host runtime at all.
  const client = useHostBinding()?.hostClient ?? null;
  const hostControls = useHostLogLevelControls({
    client,
    enabled: usable && levelsSupported !== false,
  });

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
        <HostScopeGate
          scope={scope}
          skeleton={<HostScopeConnecting hostName={scope.hostLabel} />}
        >
          <LogDetailGroup
            controls={hostControls}
            // An element is truthy however it renders, so as JSX this prop could never be the `null` that suppresses the
            // whole card - the group would title an empty "Log detail" over a component returning nothing.
            emptyState={hostLogDetailEmptyReason({
              hostName: scope.hostLabel,
              levelsSupported,
              logsSupported,
            })}
          />
          {logsSupported === false ? (
            <HostConfigUnsupportedNotice
              hostName={scope.hostLabel}
              subject="logs and log levels"
            />
          ) : (
            <HostRecentLogsSection client={client} hostName={scope.hostLabel} />
          )}
        </HostScopeGate>
      </div>
    </SettingsPanelShell>
  );
}

/** It exists because silence is the one outcome this page must not produce - it was the old shared empty copy,
 * "only available on the desktop app", that sent people to install an app they were running. */
function hostLogDetailEmptyReason(props: {
  readonly hostName: string;
  readonly levelsSupported: boolean | null;
  readonly logsSupported: boolean | null;
}): ReactNode {
  if (props.levelsSupported === false) {
    if (props.logsSupported === false) return null;
    return (
      <HostConfigUnsupportedNotice
        hostName={props.hostName}
        subject="log levels"
      />
    );
  }
  return (
    <LogInfoLine>
      Log levels for {props.hostName} aren&apos;t readable right now.
    </LogInfoLine>
  );
}

/** This computer's host, unable to answer for itself: the bridge reads the same config store and the same log
 * files that host uses. */
function DiagnosticsPanelOverLocalStore(props: {
  readonly hostName: string;
  readonly reason: LocalConfigFallbackReason;
}) {
  const compact = useSettingsDensity() === "compact";
  const hostControls = useBridgeHostLogLevelControls();
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
        <LocalConfigFallbackNotice
          hostName={props.hostName}
          reason={props.reason}
        />
        {/* The bridge path reads the on-disk store, so there is no host RPC to be too old for - its empty
           `hostControls` only ever means "this shell has no log-levels bridge", which is what the empty state says. */}
        <LogDetailGroup
          controls={hostControls}
          emptyState={
            <LogInfoLine>
              Log level controls are only available on the desktop app.
            </LogInfoLine>
          }
        />
        <BridgeRecentLogsSection />
      </div>
    </SettingsPanelShell>
  );
}

/** Recent logs for a host that can be dialled: its own log files, read over `diagnostics.logs.*`. */
function HostRecentLogsSection(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostName: string;
}): ReactNode {
  const { client } = props;
  const listQuery = useHostQuery<HostRpcRegistry, "diagnostics.logs.list">({
    cacheKeyIdentity: undefined,
    client,
    method: "diagnostics.logs.list",
    params: {},
    options: { enabled: client !== null, staleTime: 60_000 },
  });

  if (client === null) {
    return (
      <RecentLogsFrame>
        <LogInfoLine>
          There&apos;s no connection to {props.hostName}, so its log files
          can&apos;t be read from here.
        </LogInfoLine>
      </RecentLogsFrame>
    );
  }
  const hostLogs = listQuery.data?.logs ?? [];
  return (
    <RecentLogsFrame>
      {listQuery.isPending ? <LogInfoLine>Loading logs…</LogInfoLine> : null}
      {/* Without it the panel was harder to report from the worse the failure was: a single log that would not open
         could be filed, while the read that lists every log failing left the user with text and nothing to do. */}
      {listQuery.isError ? (
        <div className="flex items-start gap-2">
          <LogInfoLine>Couldn&apos;t load log details.</LogInfoLine>
          <ReportIssueAction
            context={createReportIssueContext({
              title: "Couldn't load log details",
              message: null,
              code: null,
              source: "Diagnostics",
            })}
            presentation="icon"
            className={undefined}
          />
        </div>
      ) : null}
      {listQuery.isSuccess && hostLogs.length === 0 ? (
        <LogInfoLine>No log files on {props.hostName}.</LogInfoLine>
      ) : null}
      {hostLogs.map((entry) => (
        <HostLogEntry
          key={entry.target}
          client={client}
          target={entry.target}
          label={entry.label}
          path={entry.path}
        />
      ))}
    </RecentLogsFrame>
  );
}

function BridgeRecentLogsSection(): ReactNode {
  const runnerHost = useRunnerHost();
  const support = useMemo(
    () => resolveDesktopSupportBridge(runnerHost),
    [runnerHost],
  );

  return (
    <RecentLogsFrame>
      {support === null ? (
        <LogInfoLine>
          Recent logs are only available on the desktop app.
        </LogInfoLine>
      ) : (
        <BridgeLogList support={support} />
      )}
    </RecentLogsFrame>
  );
}

function BridgeLogList(props: {
  readonly support: DesktopSupportBridge;
}): ReactNode {
  const { support } = props;
  const listQuery = useSupportSnapshotQuery(support);
  // Filtered rather than re-shaped: the bridge answers one question for both pages, and each takes its half.
  const logs = (listQuery.data?.logs ?? []).filter(
    (entry) => entry.target !== "desktop",
  );

  if (listQuery.isPending) {
    return <LogInfoLine>Loading logs…</LogInfoLine>;
  }
  if (listQuery.isError) {
    return <LogInfoLine>Couldn&apos;t load log details.</LogInfoLine>;
  }
  if (logs.length === 0) {
    return <LogInfoLine>No log files found.</LogInfoLine>;
  }
  return (
    <>
      {logs.map((entry) => (
        <BridgeLogEntry key={entry.target} entry={entry} support={support} />
      ))}
    </>
  );
}

/** `shell.showItemInFolder` opens a path on this machine, so it is meaningless for a remote host. */
function HostLogEntry(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly target: DiagnosticsLogTarget;
  readonly label: string;
  readonly path: string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const tailQuery = useHostQuery<HostRpcRegistry, "diagnostics.logs.tail">({
    cacheKeyIdentity: undefined,
    client: props.client,
    method: "diagnostics.logs.tail",
    params: { target: props.target, tailLines: LOG_TAIL_LINES },
    options: { enabled: open, staleTime: 5_000 },
  });

  let tail: LogTailView = { status: "loading" };
  if (tailQuery.isError) {
    tail = { status: "error" };
  } else if (tailQuery.isSuccess) {
    tail =
      tailQuery.data.status === "available"
        ? { status: "ready", lines: tailQuery.data.lines }
        : { status: "missing" };
  }

  return (
    <DiagnosticsLogEntryFrame
      target={props.target}
      label={props.label}
      open={open}
      onToggle={() => setOpen((value) => !value)}
      tail={tail}
      action={
        <CopyTextButton
          value={props.path}
          label="Copy path"
          ariaLabel={`Copy ${props.label} path`}
          disabled={false}
        />
      }
    />
  );
}
