import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, FolderOpen, Info } from "lucide-react";
import { toast } from "sonner";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { DiagnosticsLogTarget } from "@traycer/protocol/host/diagnostics/index";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { SettingsGroup } from "@/components/settings/settings-group";
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
import { LogLevelRow } from "@/components/settings/panels/log-level-row";
import {
  useBridgeHostLogLevelControls,
  useDesktopLogLevelControl,
  useHostLogLevelControls,
  type LogLevelControl,
} from "@/components/settings/panels/log-level-controls";
import { Button } from "@/components/ui/button";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
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
import { getDesktopHeapSnapshotBridge } from "@/lib/resources/desktop-app-resource-usage";
import { getLogLevelsBridge } from "@/lib/desktop-log-levels";
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
  DesktopSupportSnapshot,
} from "@/lib/windows/types";

const LOG_TAIL_LINES = 100;
const PANEL_DESCRIPTION =
  "Log verbosity for each Traycer component, plus recent log output. All default to Info - raise a level to Debug when capturing a problem for support, then set it back.";
/** The `cli`/`host` rows' method; the whole config family ships in one release. */
const LOG_LEVELS_GATE_METHOD = "config.logLevels.get";
/** Recent logs' method, asked separately so each region states its own truth. */
const HOST_LOGS_GATE_METHOD = "diagnostics.logs.list";

/**
 * Diagnostics for the SELECTED host, over that host's own RPC.
 *
 * The page is deliberately MIXED-scope and says so per row. `desktop` log
 * verbosity and the heap capture describe THIS window wherever it points, so
 * they render for every scope, including a host that cannot be reached. The
 * host-tied halves — `cli`/`host` verbosity and the host's own log tails — are
 * read over the scoped host's config/diagnostics RPC, which is what let the
 * `requiresLocalHost` gate go away: the values are no longer this computer's
 * shown under another host's name, they are that host's.
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
  const desktopControl = useDesktopLogLevelControl();
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
        <LogDetailGroup
          desktopControl={desktopControl}
          hostControls={hostControls}
          hostUnsupported={levelsSupported === false}
          ownsUnsupportedNotice={logsSupported !== false}
          hostName={scope.hostLabel}
        />
        <MemoryDiagnosticsGroup />
        <HostScopeGate
          scope={scope}
          skeleton={<HostScopeConnecting hostName={scope.hostLabel} />}
        >
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
 * This computer's host, unable to answer for itself: the bridge reads the same
 * config store and the same log files that host uses.
 */
function DiagnosticsPanelOverLocalStore(props: {
  readonly hostName: string;
  readonly reason: LocalConfigFallbackReason;
}) {
  const compact = useSettingsDensity() === "compact";
  const desktopControl = useDesktopLogLevelControl();
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
          be too old for - its empty `hostControls` only ever means "no bridge
          rows here", which the existing desktop-app line already describes.
        */}
        <LogDetailGroup
          desktopControl={desktopControl}
          hostControls={hostControls}
          hostUnsupported={false}
          ownsUnsupportedNotice={false}
          hostName={props.hostName}
        />
        <MemoryDiagnosticsGroup />
        <BridgeRecentLogsSection />
      </div>
    </SettingsPanelShell>
  );
}

/**
 * App/CLI/Host verbosity controls. When any level differs from the Info
 * default, a quiet reminder + one-click "Reset all to Info" appear inside the
 * same group so raising detail for support never gets forgotten.
 *
 * Mixed scope, stated per row: `cli` and `host` belong to the host this page is
 * showing, while `desktop` is this app window wherever it points. Leaving that
 * unsaid is what let the section read as "settings for one machine" and get
 * filed outside the host group. The rows arrive with their transports already
 * resolved (see `LogLevelControl`), so nothing here knows which is which.
 */
/**
 * Why the Log detail group has no rows at all.
 *
 * The desktop-app line is a claim about the SHELL, and it is false whenever
 * the rows are missing because the host is too old - it sends someone to
 * install an app they are already running. So that copy is suppressed in the
 * version case, and the real reason is stated unless the logs region below is
 * already stating it for the same host.
 */
function LogDetailEmptyReason(props: {
  readonly hostUnsupported: boolean;
  readonly ownsUnsupportedNotice: boolean;
  readonly hostName: string;
}): ReactNode {
  if (!props.hostUnsupported) {
    return (
      <LogInfoLine>
        Log level controls are only available on the desktop app.
      </LogInfoLine>
    );
  }
  if (!props.ownsUnsupportedNotice) return null;
  return (
    <HostConfigUnsupportedNotice
      hostName={props.hostName}
      subject="log levels"
    />
  );
}

function LogDetailGroup(props: {
  /** Dropped outside the desktop shell, where there is no log-levels bridge. */
  readonly desktopControl: LogLevelControl;
  /** Empty when the host cannot answer for its own config right now. */
  readonly hostControls: readonly LogLevelControl[];
  /**
   * `hostControls` is empty because the host PREDATES `config.logLevels.get`,
   * not because it is still loading.
   *
   * The two look identical from here and read very differently to the user.
   * Without it the host rows just vanish, and outside the desktop shell the
   * empty state blamed the shell ("only available on the desktop app") for
   * what is actually a host version - sending someone to install an app they
   * are already running.
   */
  readonly hostUnsupported: boolean;
  /**
   * Whether THIS group owns the explanation.
   *
   * False when the logs region below is already showing the same notice for
   * the same host - its subject is literally "logs and log levels", so a
   * second copy here would state the reason twice on one page.
   */
  readonly ownsUnsupportedNotice: boolean;
  readonly hostName: string;
}): ReactNode {
  const desktopAvailable = getLogLevelsBridge() !== null;
  const activeControls = useMemo(
    (): readonly LogLevelControl[] => [
      ...(desktopAvailable ? [props.desktopControl] : []),
      ...props.hostControls,
    ],
    [desktopAvailable, props.desktopControl, props.hostControls],
  );
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

  const nonDefaultControls = useMemo(
    () =>
      activeControls.filter(
        (control) => control.level !== undefined && control.level !== "info",
      ),
    [activeControls],
  );

  useEffect(() => {
    const isVisible = nonDefaultControls.length > 0;
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
  }, [nonDefaultControls.length]);

  const handleResetAll = async (): Promise<void> => {
    const controls = nonDefaultControls;
    setResetPending(true);
    let failedCount = 0;
    for (const control of controls) {
      try {
        await control.set("info");
      } catch {
        // The control's own transport already toasted this scope - keep
        // going so one failure doesn't strand the remaining scopes
        // un-attempted and silently still elevated.
        failedCount += 1;
      }
    }
    setResetPending(false);
    // Only the MULTI-control case earns an aggregate line: with one control
    // its transport's own toast already said the same thing, and a second
    // would double-report a single failure. The plural is unconditional
    // because this branch cannot be reached with fewer than two controls.
    if (failedCount > 0 && controls.length > 1) {
      toast.error(
        `Couldn't reset ${failedCount} of ${controls.length} log levels`,
      );
    }
  };

  if (activeControls.length === 0) {
    return (
      <SettingsGroup
        title="Log detail"
        tone="default"
        dataTestId={undefined}
        fill={false}
      >
        <LogDetailEmptyReason
          hostUnsupported={props.hostUnsupported}
          ownsUnsupportedNotice={props.ownsUnsupportedNotice}
          hostName={props.hostName}
        />
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
        {activeControls.map((control) => (
          <LogLevelRow
            key={control.scope}
            control={control}
            disabled={resetPending}
          />
        ))}
        {props.hostUnsupported && props.ownsUnsupportedNotice ? (
          <HostConfigUnsupportedNotice
            hostName={props.hostName}
            subject="log levels"
          />
        ) : null}
        {nonDefaultControls.length > 0 ? (
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

/**
 * On-demand heap capture for memory reports. The renderer freezes while V8
 * walks the heap and the file runs to gigabytes on exactly the long-lived
 * sessions worth capturing, so this is a deliberate button rather than
 * anything automatic - and the warning is stated up front, not after the fact.
 * The resulting path is shown for copying rather than revealed in the file
 * manager: no reveal capability is exposed for arbitrary paths.
 */
/** Serialization scope for the heap capture - see the `scope` note below. */
const HEAP_SNAPSHOT_MUTATION_SCOPE = "runner-heap-snapshot";

function MemoryDiagnosticsGroup(): ReactNode {
  const bridge = useMemo(() => getDesktopHeapSnapshotBridge(), []);
  const [snapshotPath, setSnapshotPath] = useState<string | null>(null);

  const captureMutation = useMutation({
    mutationKey: runnerMutationKeys.captureHeapSnapshot(),
    // `scope` is what actually serializes mutations in TanStack Query -
    // `mutationKey` alone does not. Without it the only thing standing
    // between a double-click and two concurrent multi-gigabyte heap walks
    // is the `disabled` prop, which cannot help a second mounted panel.
    scope: { id: HEAP_SNAPSHOT_MUTATION_SCOPE },
    mutationFn: (): Promise<string | null> =>
      bridge === null ? Promise.resolve(null) : bridge.takeHeapSnapshot(),
    onSuccess: (path) => {
      setSnapshotPath(path);
      if (path === null) {
        toast.error("Couldn't capture a heap snapshot");
      }
    },
    onError: (error) => {
      // Clear the previous run's path. Leaving it rendered under a failure
      // toast offers a Copy button for a file this capture never wrote -
      // the user pastes it into a report as the snapshot they just took.
      setSnapshotPath(null);
      toastFromRunnerError(error, "Couldn't capture a heap snapshot");
    },
  });

  if (bridge === null) {
    return (
      <SettingsGroup
        title="Memory"
        tone="default"
        dataTestId={undefined}
        fill={false}
      >
        <LogInfoLine>
          Memory snapshots are only available on the desktop app.
        </LogInfoLine>
      </SettingsGroup>
    );
  }

  return (
    <SettingsGroup
      title="Memory"
      tone="default"
      dataTestId={undefined}
      fill={false}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
        <span className="min-w-0 flex-1 text-ui-xs text-muted-foreground">
          Captures a heap snapshot of this window for a memory report. The app
          stops responding while the snapshot is written, and the file can be
          several gigabytes.
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={captureMutation.isPending}
          onClick={() => captureMutation.mutate()}
          data-testid="diagnostics-capture-heap-snapshot"
        >
          {captureMutation.isPending ? (
            <AgentSpinningDots
              className="text-current"
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          Capture heap snapshot
        </Button>
      </div>
      {snapshotPath === null ? null : (
        <div className="flex items-start gap-2 px-4 pb-3">
          <pre
            className="min-w-0 flex-1 overflow-auto rounded-md border border-border/60 bg-muted/30 px-3 py-2 font-mono text-code-xs text-muted-foreground"
            data-testid="diagnostics-heap-snapshot-path"
          >
            {snapshotPath}
          </pre>
          <CopyTextButton
            value={snapshotPath}
            label="Copy"
            ariaLabel="Copy heap snapshot path"
            disabled={false}
          />
        </div>
      )}
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
 * height and becomes the page's primary scroll owner.
 */
function RecentLogsFrame(props: { readonly children: ReactNode }): ReactNode {
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

/**
 * Recent logs for a host that can be dialled: its OWN log files, read over
 * `diagnostics.logs.*`, plus this app's log from the local support bridge.
 *
 * The app entry is kept deliberately. Its subject is this window — the same
 * argument the `desktop` verbosity row makes one card above — and it is the
 * only place in the product that surfaces the desktop log tail. Dropping it
 * once the host's own logs arrived would have quietly removed it from the local
 * case it has always served.
 */
function HostRecentLogsSection(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostName: string;
}): ReactNode {
  const { client } = props;
  const runnerHost = useRunnerHost();
  const support = useMemo(
    () => resolveDesktopSupportBridge(runnerHost),
    [runnerHost],
  );
  const listQuery = useHostQuery<HostRpcRegistry, "diagnostics.logs.list">({
    cacheKeyIdentity: undefined,
    client,
    method: "diagnostics.logs.list",
    params: {},
    options: { enabled: client !== null, staleTime: 60_000 },
  });

  const hostLogs = listQuery.data?.logs ?? [];
  if (client === null && support === null) {
    return (
      <RecentLogsFrame>
        <LogInfoLine>
          Recent logs are only available on the desktop app.
        </LogInfoLine>
      </RecentLogsFrame>
    );
  }
  return (
    <RecentLogsFrame>
      {support === null ? null : <DesktopAppLogEntry support={support} />}
      {client !== null && listQuery.isPending ? (
        <LogInfoLine>Loading logs…</LogInfoLine>
      ) : null}
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

function useSupportSnapshotQuery(support: DesktopSupportBridge) {
  return useQuery(
    queryOptions<DesktopSupportSnapshot>({
      queryKey: runnerQueryKeys.supportLogList(
        supportBridgeQueryScopeId(support),
      ),
      queryFn: () => support.getSnapshot(),
      staleTime: 60_000,
    }),
  );
}

function BridgeLogList(props: {
  readonly support: DesktopSupportBridge;
}): ReactNode {
  const { support } = props;
  const listQuery = useSupportSnapshotQuery(support);
  const logs = listQuery.data?.logs ?? [];

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
 * This app's own log, alongside a dialled host's logs. Sourced from the local
 * bridge whatever the scope is, exactly like the `desktop` verbosity row, and
 * silent while the snapshot loads — the host entries below carry the section's
 * loading state.
 */
function DesktopAppLogEntry(props: {
  readonly support: DesktopSupportBridge;
}): ReactNode {
  const listQuery = useSupportSnapshotQuery(props.support);
  const entry =
    listQuery.data?.logs.find((log) => log.target === "desktop") ?? null;
  if (entry === null) return null;
  return <BridgeLogEntry entry={entry} support={props.support} />;
}

function LogInfoLine(props: { readonly children: ReactNode }): ReactNode {
  return (
    <div className="px-5 py-4 text-ui-sm text-muted-foreground">
      {props.children}
    </div>
  );
}

/** What an expanded row has to show, whichever transport produced it. */
type LogTailView =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  /** The host advertised the file, then could not read it back. */
  | { readonly status: "missing" }
  | { readonly status: "ready"; readonly lines: readonly string[] };

function BridgeLogEntry(props: {
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

function DiagnosticsLogEntryFrame(props: {
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
            className="max-h-52 min-w-0 flex-1 overflow-auto rounded-md border border-border/60 bg-muted/30 px-3 py-2 font-mono text-code-xs text-muted-foreground"
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
