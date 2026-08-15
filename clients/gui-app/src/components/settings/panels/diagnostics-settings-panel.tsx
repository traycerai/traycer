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
/** The `cli`/`host` rows' method; the whole config family ships in one release. */
const LOG_LEVELS_GATE_METHOD = "config.logLevels.get";
/** Recent logs' method, asked separately so each region states its own truth. */
const HOST_LOGS_GATE_METHOD = "diagnostics.logs.list";

/**
 * Diagnostics for the SELECTED host, over that host's own RPC.
 *
 * Wholly host-scoped, which it did not used to be. The page carried three
 * app-scoped surfaces as well — the `desktop` verbosity row, the heap capture,
 * and this window's own log tail — under a doc comment that called the mixed
 * scope deliberate and stated it per row. Per-row honesty was not the problem;
 * REPETITION was. All three describe one app and one window, so an account with
 * four hosts rendered four copies of each, with two of them writing the same
 * single value from four places. They now live once, under Application ->
 * Diagnostics (`app-diagnostics-settings-panel.tsx`), and this page is left
 * with exactly what varies by host: `cli`/`host` verbosity and that host's own
 * log files.
 *
 * That is also why both regions now sit INSIDE `HostScopeGate` rather than
 * beside it. The gate was previously wrapped around the logs alone, because Log
 * detail always had the app row to show for an unreachable host; with nothing
 * app-scoped left, a group rendered outside the gate would be an empty card
 * under a host that cannot answer.
 *
 * The one exception is `localConfigFallbackReason`: this computer's host, when
 * its process cannot answer — stopped, or a version predating these methods —
 * still has to be readable, because those are exactly the moments someone is
 * trying to find out what is wrong with it. There the local bridge answers, as
 * it always did, under a notice naming which of the two it is. A remote host in
 * either state gets the capability notice: no local truth describes it.
 */
export function DiagnosticsSettingsPanel() {
  const scope = useHostScope();
  // Hoisted above the branch, which depends on it. Nullable on purpose: `false`
  // is a host that handshaked WITHOUT the method; `null` is "no handshake yet",
  // and this page's own first RPC is what produces one — so treating `null` as
  // absent would divert a capable host onto the bridge before ever trying it.
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
  // Keyed on the config family, the same one the Shell page uses — the two
  // families ship in one host release, so either answers "does this host
  // predate the batch", and one predicate keeps the two pages consistent.
  const fallbackReason = localConfigFallbackReason(scope.host, levelsSupported);
  // Both `false` outcomes below — the bridge fallback and the remote capability
  // notice — park every host read this page owns, including the handshake that
  // would overturn the verdict. The probe keeps the answer refutable;
  // `scope.client` (never the ambient one) so it asks the host being shown.
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
  /** Both resolved by the panel above, which branches on the first. */
  readonly levelsSupported: boolean | null;
  readonly logsSupported: boolean | null;
}) {
  const { scope, levelsSupported, logsSupported } = props;
  const compact = useSettingsDensity() === "compact";
  // MOUNTING, not rendering: a query hook mounted under a non-ready scope still
  // fires against the ambient host and caches its answer, however well the gate
  // hides the result.
  const usable = isHostScopeUsable(scope.status);

  // The BINDING rather than `useHostClient()`: same context, re-provided by the
  // panel above for an explicit pick, but `null` instead of a throw when there
  // is no host runtime at all. Every host-scoped read below is null-gated.
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
            // CALLED, not rendered as `<HostLogDetailEmptyReason />`. An
            // element is truthy however it renders, so as JSX this prop could
            // never be the `null` that suppresses the whole card — the group
            // would title an empty "Log detail" over a component returning
            // nothing.
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

/**
 * Why this host has no verbosity rows.
 *
 * Returns `null` — and so renders no Log detail card at all — when the logs
 * region below is already stating the same version fact for the same host. Its
 * subject is literally "logs and log levels", so a second copy here would say
 * it twice on one screen.
 *
 * The residual arm is defensive rather than routine: inside `HostScopeGate` a
 * usable scope has a client, so `useHostLogLevelControls` returns its two rows
 * (loading, but present). It exists because silence is the one outcome this
 * page must not produce — it was the old shared empty copy, "only available on
 * the desktop app", that sent people to install an app they were running.
 *
 * A plain function rather than a component, and named like one, because its
 * caller needs the RESULT: `LogDetailGroup` decides whether to render a card at
 * all by testing this for `null`, which an element wrapper would defeat.
 */
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

/**
 * This computer's host, unable to answer for itself: the bridge reads the same
 * config store and the same log files that host uses.
 */
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
        {/*
          The bridge path reads the on-disk store, so there is no host RPC to
          be too old for - its empty `hostControls` only ever means "this shell
          has no log-levels bridge", which is what the empty state says.
        */}
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

/**
 * Recent logs for a host that can be dialled: its OWN log files, read over
 * `diagnostics.logs.*`.
 *
 * This app's log used to be listed alongside them, sourced from the local
 * bridge whatever the scope was. That was defensible per-page and wrong across
 * pages: one file, N hosts, N identical entries. It is now the whole content of
 * Application -> Diagnostics.
 */
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
      {/*
        Carries the same report-issue affordance a failed TAIL read offers.
        Without it the panel was harder to report from the worse the failure
        was: a single log that would not open could be filed, while the read
        that lists every log failing left the user with text and nothing to do.
      */}
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

/** Recent logs through the desktop support bridge — the stopped-local path. */
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
  // The snapshot carries `desktop` as well as `host`, and this page is no
  // longer where the app's own log belongs — Application -> Diagnostics reads
  // the same entry from the same snapshot. Filtered rather than re-shaped: the
  // bridge answers one question for both pages, and each takes its half.
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

/**
 * One of the scoped host's own log files.
 *
 * Reveal is deliberately NOT offered here. `shell.showItemInFolder` opens a
 * path on THIS machine, so it is meaningless for a remote host — and even for a
 * local one it would resolve the path itself rather than the one the host just
 * named, which is a different file the moment two host slots share a machine.
 * The plan's degrade is the honest one: show the path and offer to copy it.
 */
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
