import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { FolderSearch, History, Search } from "lucide-react";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { SessionImportStatusResponse } from "@traycer/protocol/host/session-import/contracts";
import type {
  SessionImportGroup,
  SessionImportSelection,
} from "@traycer/protocol/host/session-import/candidate";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import type { SessionImportImportedSupport } from "@traycer-clients/shared/host-transport/session-import-scan-client";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import {
  buildSessionImportSubmission,
  buildSessionImportView,
  harnessDisplayName,
  selectionStateFor,
  sessionImportScanWindowLabel,
  sessionImportSelectionKey,
  SESSION_IMPORT_SCAN_WINDOW_OPTIONS,
  type SessionImportProviderView,
  type SessionImportScanWindow,
  type SessionImportWizardState,
  type SessionImportWizardView,
} from "@/components/session-import/session-import-model";
import {
  SelectionBox,
  SessionImportGroupItem,
  SessionImportTaskRow,
} from "@/components/session-import/session-import-group";
import { SessionImportProgress } from "@/components/session-import/session-import-progress";
import type { SessionImportScanHandle } from "@/components/session-import/use-session-import-scan";
import {
  attachSessionImportRun,
  startSessionImportRun,
} from "@/components/session-import/session-import-run-handle";
import { useSessionImportCheckStatus } from "@/hooks/session-import/use-session-import-check-status-query";
import { useStreamRuntimeBinding } from "@/lib/host/stream-runtime-context";
import {
  sessionImportTone,
  type SessionImportTone,
  type SessionImportSurface,
} from "@/components/session-import/session-import-tone";
import {
  sessionImportRunFor,
  useSessionImportRun,
  useSessionImportRunStore,
  type SessionImportRunStatus,
} from "@/stores/session-import/session-import-run-store";
import { useFeatureAnnouncementsStore } from "@/stores/settings/feature-announcements-store";

export interface SessionImportSecondaryAction {
  readonly label: string;
  readonly onSelect: () => void;
}

/**
 * The one import surface, used by the onboarding act and the Settings dialog
 * alike (spec D3). It hands the user's selection to the app-wide run
 * controller rather than owning the run itself - which is what lets it be
 * closed mid-import.
 *
 * The scan is the caller's (`useSessionImportScan`), because the two surfaces
 * start it at different moments: the dialog when it opens, the tour when it
 * begins - several acts before this wizard is on screen (D13, revised).
 *
 * Both surfaces submit through the wizard's own Import button. The tour used
 * to submit through its Continue instead, which imported the default selection
 * without an explicit ask; an import now starts only when Import is pressed.
 */
export function SessionImportWizard(props: {
  readonly hostPicker: ReactNode;
  readonly surface: SessionImportSurface;
  readonly scan: SessionImportScanHandle;
  /** Called once a run has been submitted, so the caller can move on. */
  readonly onImportStarted: () => void;
  readonly onTaskOpened: () => void;
  readonly onBeforeTaskOpen: (() => Promise<boolean>) | null;
  readonly secondaryAction: SessionImportSecondaryAction | null;
}) {
  const { surface, scan, onImportStarted, secondaryAction } = props;
  const tone = sessionImportTone(surface);
  const [groupByProject, setGroupByProject] = useState(false);
  // The run this wizard shows and starts is the one on the host it renders
  // under - transport and host name off the same binding, which is also what
  // the submission is aimed at.
  const streamBinding = useStreamRuntimeBinding();
  const hostId = streamBinding?.hostId ?? null;
  const runStatus = useSessionImportRun(hostId).status;
  const runIdle = runStatus === "idle";
  // No catalog warm-up here, deliberately, and the reason is worth keeping.
  //
  // This used to prefetch the target host's `agent.gui.listHarnesses` rows
  // because `importPermissionModeFor` fell back to them to decide whether the
  // host knew `auto`. That fallback is gone - a catalog row is a different
  // method's fact - so the warm-up was paying an RPC to fill a slot nothing
  // reads. The gate now asks `sessionImport.run`'s own line and nothing else.
  //
  // What warms THAT line is already on screen: `useSessionImportScan` opens a
  // `sessionImport.scan` subscription on this same binding's client while the
  // user is still picking rows, and a stream handshake caches a declarable
  // version for every method in the peer's manifest - `sessionImport.run`
  // included - so the line is warm before the Import button exists to click.
  const statusQuery = useSessionImportCheckStatus(streamBinding, runIdle);
  const activeRun = statusQuery.isSuccess ? statusQuery.data.active : null;
  const canSubmit = sessionImportHostIsIdle(statusQuery);
  const checkingStatus = !statusQuery.isError && !canSubmit;
  // The controller only probes the app's host on its own. A wizard on any
  // other host checks through Query first and attaches without selections.
  // Submission stays disabled until an idle answer arrives, including when
  // the onboarding scan was populated before this wizard mounted.
  useEffect(() => {
    if (!runIdle || !statusQuery.isSuccess || statusQuery.isFetching) return;
    if (activeRun !== null) attachSessionImportRun(streamBinding, activeRun);
  }, [
    activeRun,
    runIdle,
    statusQuery.isFetching,
    statusQuery.isSuccess,
    streamBinding,
  ]);
  // Meeting the wizard on any surface - the tour act, the Settings dialog,
  // the release toast's own dialog - is the announcement: the id is consumed
  // on mount so the toast never follows for a user who has already opened
  // the feature, whether or not they imported anything. Only reaching the
  // wizard counts; skipping the tour before its act does not, so a skipper
  // still gets the toast (unlike `login-import`, which the tour's finish
  // consumes unconditionally).
  const consumeAnnouncement = useFeatureAnnouncementsStore(
    (state) => state.consume,
  );
  useEffect(() => {
    consumeAnnouncement("session-import");
  }, [consumeAnnouncement]);

  // Opening the wizard retires a FINISHED run's summary, so a second visit
  // scans afresh instead of re-reading last time's result. It does not re-run
  // while this wizard is open on one host: a run that finishes here still
  // shows its summary, because that summary is what the user is waiting for.
  // A host change is a fresh opening onto a different machine, so the same
  // retirement applies to it.
  useEffect(() => {
    if (hostId === null) return;
    const store = useSessionImportRunStore.getState();
    const run = sessionImportRunFor(store, hostId);
    if (run.status === "complete" || run.status === "error") {
      store.reset(hostId);
    }
  }, [hostId]);

  const { state, dispatch } = scan;
  const view = useMemo(() => buildSessionImportView(state), [state]);
  const taskRows = useMemo(
    () =>
      view.groups
        .flatMap((group) => group.rows)
        .sort((a, b) => b.candidate.updatedAt - a.candidate.updatedAt),
    [view.groups],
  );
  // Rows the scan found but nobody can import: the footer names them so the
  // gap between "34 tasks" on screen and "31 selected" has an explanation.
  // Already-imported rows are deliberately not counted - they carry their own
  // chip and their own way in.
  const unavailableCount = useMemo(
    () =>
      view.groups.reduce(
        (total, group) =>
          total +
          group.rows.filter((row) => row.candidate.state.kind === "unreadable")
            .length,
        0,
      ),
    [view.groups],
  );
  const onboarding = surface === "onboarding";

  const submit = (): void => {
    // A run already under way owns the screen, and the button is not rendered
    // then - this guards a click that raced the store.
    if (!runIdle || !canSubmit) return;
    const submission = buildSessionImportSubmission(state);
    if (submission.selections.length === 0) return;
    Analytics.getInstance().track(AnalyticsEvent.SessionImportStarted, {
      surface,
      session_count: submission.selections.length,
      group_count: submittedGroupCount(state.groups, submission.selections),
    });
    startSessionImportRun(submission, streamBinding);
    onImportStarted();
  };

  if (!runIdle) {
    return (
      <>
        {props.hostPicker}
        <SessionImportRunView
          tone={tone}
          hostId={hostId}
          runStatus={runStatus}
          secondaryAction={secondaryAction}
        />
      </>
    );
  }

  const filterProps = {
    tone,
    query: state.query,
    providers: view.providers,
    scanning: state.phase === "scanning",
    scanWindow: state.scanWindow,
    showImported: state.showImported,
    importedSupport: state.importedSupport,
    onShowImportedChange: (showImported: boolean) =>
      dispatch({ kind: "showImportedChanged", showImported }),
    onQueryChange: (query: string) => dispatch({ kind: "queryChanged", query }),
    onToggleProvider: (harness: GuiHarnessId) =>
      dispatch({ kind: "providerScopeToggled", harness }),
    onScanWindowChange: (window: SessionImportScanWindow) =>
      dispatch({ kind: "windowChanged", window }),
  };

  // Hoisted so the two shapes read as one choice rather than a ternary
  // nested in a ternary.
  const scanningIndicator =
    onboarding && view.groups.length === 0 ? (
      // Nothing to read yet, so the panel is one centred card rather
      // than a lone line of 12px text on an empty field.
      <div className="onboarding-import-card">
        <AgentSpinningDots
          className={tone.muted}
          testId="session-import-scan-spinner"
          variant={undefined}
        />
        <p className={cn("text-ui-sm", tone.muted)}>
          Looking for your recent tasks…
        </p>
      </div>
    ) : (
      // px-2.5 sits the spinner on the same column as the checkboxes in
      // the cards above it.
      <div className="flex shrink-0 items-center gap-2 px-2.5 py-2">
        <AgentSpinningDots
          className={tone.faint}
          testId="session-import-scan-spinner"
          variant={undefined}
        />
        <span className={cn("text-ui-xs tabular-nums", tone.faint)}>
          Finding tasks…
          {view.totalSessions > 0
            ? ` ${view.totalSessions.toLocaleString()} found`
            : ""}
        </span>
      </div>
    );

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      {onboarding ? (
        <SessionImportOnboardingToolbar
          {...filterProps}
          hostPicker={props.hostPicker}
          view={view}
          dispatch={dispatch}
          groupByProject={groupByProject}
          setGroupByProject={setGroupByProject}
        />
      ) : (
        <>
          <SessionImportFilters
            {...filterProps}
            hostPicker={props.hostPicker}
          />
          <SessionImportSelectionToolbar
            view={view}
            tone={tone}
            dispatch={dispatch}
          />
        </>
      )}

      <div
        data-surface={surface}
        className="session-import-groups flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-4 py-3"
      >
        {state.scanErrorDetail !== null ? (
          <p
            data-testid="session-import-scan-error"
            className={cn(
              "shrink-0 rounded-md px-2.5 py-1.5 text-ui-xs",
              tone.warningSurface,
            )}
          >
            Scan interrupted. {state.scanErrorDetail}
          </p>
        ) : null}

        {state.providerFailures.map((failure) => (
          <p
            key={failure.harness}
            data-testid="session-import-provider-failure"
            className={cn(
              "shrink-0 rounded-md px-2.5 py-1.5 text-ui-xs",
              tone.warningSurface,
            )}
          >
            Couldn’t read {harnessDisplayName(failure.harness)} tasks.{" "}
            {failure.detail}
          </p>
        ))}

        {onboarding && !groupByProject ? (
          <div className="onboarding-import-list">
            {taskRows.map((row) => (
              <SessionImportTaskRow
                key={row.selectionKey}
                row={row}
                tone={tone}
                showFolder
                onToggle={(selectionKey) =>
                  dispatch({ kind: "sessionToggled", selectionKey })
                }
                onTaskOpened={props.onTaskOpened}
                onBeforeTaskOpen={props.onBeforeTaskOpen}
              />
            ))}
          </div>
        ) : (
          view.groups.map((group) => (
            <SessionImportGroupItem
              key={group.groupKey}
              group={group}
              tone={tone}
              onToggleExpanded={(groupKey) =>
                dispatch({ kind: "groupExpansionToggled", groupKey })
              }
              onSetGroupSelection={(groupKey, selected) =>
                dispatch({ kind: "groupSelectionSet", groupKey, selected })
              }
              onTaskOpened={props.onTaskOpened}
              onBeforeTaskOpen={props.onBeforeTaskOpen}
              onToggleSession={(selectionKey) =>
                dispatch({ kind: "sessionToggled", selectionKey })
              }
            />
          ))
        )}
        {state.phase === "scanning" ? scanningIndicator : null}
        <SessionImportEmptyState
          state={state}
          view={view}
          tone={tone}
          onShowImported={() =>
            dispatch({ kind: "showImportedChanged", showImported: true })
          }
        />
      </div>

      {statusQuery.isError ? (
        <div role="alert" className="flex items-center gap-2 px-4 py-2">
          <p className={cn("text-ui-xs", tone.muted)}>
            Couldn’t check for an active import.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={statusQuery.isFetching}
            onClick={() => void statusQuery.refetch()}
          >
            Try again
          </Button>
        </div>
      ) : null}
      <SessionImportFooter
        tone={tone}
        view={view}
        unavailableCount={unavailableCount}
        canSubmit={canSubmit}
        checkingStatus={checkingStatus}
        secondaryAction={secondaryAction}
        onSubmit={submit}
      />
    </div>
  );
}

function SessionImportEmptyState(props: {
  readonly state: SessionImportWizardState;
  readonly view: SessionImportWizardView;
  readonly tone: SessionImportTone;
  readonly onShowImported: () => void;
}) {
  const { state, view, tone, onShowImported } = props;
  const onboarding = tone.surface === "onboarding";
  if (state.phase === "scanning" || view.groups.length > 0) return null;
  return (
    <div
      data-testid="session-import-empty"
      className={cn(
        onboarding
          ? "onboarding-import-card"
          : "mx-auto max-w-[26rem] px-1 py-10",
        "text-center text-ui-sm leading-relaxed text-pretty",
        tone.muted,
      )}
    >
      {/* Neutral, not a status: nothing has gone wrong, there is just nothing
          here. Same glyph anatomy as the running, summary and error cards so
          the panel's states read as one family. */}
      {onboarding ? (
        <span className="onboarding-import-glyph border-foreground/10 bg-foreground/8 text-muted-foreground">
          <FolderSearch aria-hidden className="size-5" />
        </span>
      ) : null}
      <p>{emptyMessage(state, view)}</p>
      {view.hiddenImportedCount > 0 && state.importedSupport === "supported" ? (
        <Button
          variant="link"
          className="block mx-auto"
          onClick={onShowImported}
        >
          Show imported
        </Button>
      ) : null}
    </div>
  );
}

/** A pending, failed, or refetching status cannot authorize a new import. */
function sessionImportHostIsIdle(
  query: UseQueryResult<SessionImportStatusResponse, HostRpcError>,
): boolean {
  return query.isSuccess && !query.isFetching && query.data.active === null;
}

/**
 * The pinned header: search over everything, the scan-window picker, one pill
 * per provider the scan covers.
 */
function SessionImportFilters(props: {
  readonly hostPicker: ReactNode;
  readonly tone: SessionImportTone;
  readonly query: string;
  readonly providers: ReadonlyArray<SessionImportProviderView>;
  readonly scanning: boolean;
  readonly scanWindow: SessionImportScanWindow;
  readonly showImported: boolean;
  readonly importedSupport: SessionImportImportedSupport;
  readonly onShowImportedChange: (showImported: boolean) => void;
  readonly onQueryChange: (query: string) => void;
  readonly onToggleProvider: (harness: GuiHarnessId) => void;
  readonly onScanWindowChange: (window: SessionImportScanWindow) => void;
}) {
  const {
    tone,
    query,
    providers,
    scanning,
    scanWindow,
    onQueryChange,
    onToggleProvider,
    onScanWindowChange,
  } = props;
  return (
    <div
      className={cn(
        "session-import-filters flex shrink-0 flex-col gap-2 border-b px-4 py-3",
        tone.border,
      )}
    >
      <div className="session-import-toolbar flex min-w-0 items-center gap-3">
        {props.hostPicker}
        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden
            className={cn(
              "pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2",
              tone.faint,
            )}
          />
          <Input
            type="search"
            value={query}
            aria-label="Search work"
            placeholder="Search tasks or folders"
            data-testid="session-import-search"
            onChange={(event) => onQueryChange(event.target.value)}
            className="h-8 pl-8"
            size="sm"
          />
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {/* Rendered even before the first group lands: on an empty result the
            window picker is the one control that can bring older work in. */}
        <ScanWindowSelect
          tone={tone}
          scanWindow={scanWindow}
          onChange={onScanWindowChange}
        />
        {providers.map((provider) => (
          <ProviderPill
            key={provider.harness}
            provider={provider}
            pending={scanning}
            tone={tone}
            onToggle={onToggleProvider}
          />
        ))}
        <ImportedVisibilityToggle
          tone={tone}
          showImported={props.showImported}
          support={props.importedSupport}
          onChange={props.onShowImportedChange}
        />
      </div>
    </div>
  );
}

function importedVisibilityNotice(
  support: SessionImportImportedSupport,
): string | null {
  switch (support) {
    case "unsupported":
      return "Update this host to view imported tasks";
    case "unknown":
      return "Checking host support…";
    case "supported":
      return null;
  }
}

function ImportedVisibilityToggle(props: {
  readonly tone: SessionImportTone;
  readonly showImported: boolean;
  readonly support: SessionImportImportedSupport;
  readonly onChange: (showImported: boolean) => void;
}) {
  const { tone, showImported, support, onChange } = props;
  const switchId = useId();
  const disabled = support !== "supported";
  const checked = showImported && !disabled;
  return (
    <div
      className={cn(
        "ml-auto flex items-center gap-1.5 px-2 py-1 text-ui-xs",
        disabled && "opacity-55",
        tone.muted,
      )}
    >
      <TooltipWrapper
        label={importedVisibilityNotice(support)}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <Switch
          id={switchId}
          checked={checked}
          aria-label="Show imported"
          // Keep unavailable controls focusable so the host-support tooltip
          // is also accessible from the keyboard.
          aria-disabled={disabled}
          data-testid="session-import-show-imported"
          onCheckedChange={(next) => {
            if (!disabled) onChange(next);
          }}
        />
      </TooltipWrapper>
      <label htmlFor={switchId}>Show imported</label>
    </div>
  );
}

/**
 * The one silhouette the whole scope row wears, so the window picker and the
 * provider pills are measurably the same object - same height, radius, padding
 * and type size - rather than two controls that merely resemble each other.
 */
const SCOPE_PILL_SHAPE = "h-6 gap-1.5 rounded-full border px-2.5 text-ui-xs";

/**
 * How far back the scan looks. Picking a value IS the scan: the hook watches
 * this half of the state and starts a fresh, host-bounded scan for it - there
 * is deliberately no separate "rescan" button to pair with it.
 */
function ScanWindowSelect(props: {
  readonly tone: SessionImportTone;
  readonly scanWindow: SessionImportScanWindow;
  readonly onChange: (window: SessionImportScanWindow) => void;
}) {
  const { tone, scanWindow, onChange } = props;
  return (
    <Select
      value={scanWindow === null ? "all" : String(scanWindow)}
      onValueChange={(value) => {
        const option = SESSION_IMPORT_SCAN_WINDOW_OPTIONS.find(
          (candidate) =>
            (candidate.window === null ? "all" : String(candidate.window)) ===
            value,
        );
        if (option !== undefined) onChange(option.window);
      }}
    >
      {/* Dressed as one of the pills beside it: the whole control row is the
          scan's scope, and a lone square box in a row of rounds reads as a
          different kind of thing. The primitive's own chrome fights that - it
          pins its height behind the size variant, fills itself in dark mode,
          and carries no hover - so each of those is squared with the pills
          explicitly here. */}
      <SelectTrigger
        aria-label="How far back to look"
        data-testid="session-import-scan-window"
        className={cn(
          SCOPE_PILL_SHAPE,
          "py-0 data-[size=default]:h-6",
          "text-muted-foreground/70 hover:bg-foreground/6 hover:text-muted-foreground dark:bg-transparent dark:hover:bg-foreground/6",
          "focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-3.5",
          tone.border,
        )}
      >
        <History aria-hidden className={cn("size-3.5", tone.faint)} />
        <SelectValue>{sessionImportScanWindowLabel(scanWindow)}</SelectValue>
      </SelectTrigger>
      <SelectContent align="start">
        {SESSION_IMPORT_SCAN_WINDOW_OPTIONS.map((option) => (
          <SelectItem
            key={option.window === null ? "all" : String(option.window)}
            value={option.window === null ? "all" : String(option.window)}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * The pinned footer: just the actions that end the conversation. The selection
 * count and the master checkbox live at the head of the list they describe.
 */
function SessionImportFooter(props: {
  readonly tone: SessionImportTone;
  readonly view: SessionImportWizardView;
  readonly unavailableCount: number;
  readonly canSubmit: boolean;
  readonly checkingStatus: boolean;
  readonly secondaryAction: SessionImportSecondaryAction | null;
  readonly onSubmit: () => void;
}) {
  const { tone, view, canSubmit, checkingStatus, secondaryAction, onSubmit } =
    props;
  const onboarding = tone.surface === "onboarding";
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2",
        onboarding
          ? "onboarding-import-footer justify-between"
          : "justify-end px-4 py-3",
        tone.surface === "dialog" && "border-t",
        tone.border,
      )}
    >
      {onboarding ? (
        <p
          data-testid="session-import-footer-count"
          className={cn("min-w-0 truncate text-ui-xs tabular-nums", tone.muted)}
        >
          {view.selectedCount.toLocaleString()} selected
          {props.unavailableCount > 0
            ? ` · ${props.unavailableCount.toLocaleString()} unavailable`
            : ""}
        </p>
      ) : null}
      {secondaryAction !== null ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={secondaryAction.onSelect}
        >
          {secondaryAction.label}
        </Button>
      ) : null}
      {tone.surface === "onboarding" ? (
        <button
          type="button"
          data-testid="session-import-submit"
          className="onboarding-button onboarding-button--primary tabular-nums"
          disabled={!canSubmit || view.selectedCount === 0}
          onClick={onSubmit}
        >
          {checkingStatus ? (
            <AgentSpinningDots
              className={tone.muted}
              testId="session-import-status-spinner"
              variant={undefined}
            />
          ) : null}
          Import {view.selectedCount}{" "}
          {view.selectedCount === 1 ? "task" : "tasks"}
        </button>
      ) : (
        <Button
          type="button"
          size="sm"
          data-testid="session-import-submit"
          className="tabular-nums"
          disabled={!canSubmit || view.selectedCount === 0}
          onClick={onSubmit}
        >
          {checkingStatus ? (
            <AgentSpinningDots
              className={tone.muted}
              testId="session-import-status-spinner"
              variant={undefined}
            />
          ) : null}
          Import {view.selectedCount}{" "}
          {view.selectedCount === 1 ? "task" : "tasks"}
        </Button>
      )}
    </div>
  );
}

function ProviderPill(props: {
  readonly provider: SessionImportProviderView;
  /** True while the scan is still running, when a zero has no verdict yet. */
  readonly pending: boolean;
  readonly tone: SessionImportTone;
  readonly onToggle: (harness: GuiHarnessId) => void;
}) {
  const { provider, pending, tone, onToggle } = props;
  // No number while the scan could still change it - a mid-scan zero means
  // "not yet", not "nothing". Once the scan settles, 0 is the honest answer;
  // the old "—" placeholder read as a minus control inside a clickable pill.
  const count = pillCountLabel(provider.count, pending);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={provider.enabled}
      data-testid="session-import-provider-pill"
      data-harness={provider.harness}
      onClick={() => onToggle(provider.harness)}
      className={cn(
        "inline-flex min-w-0 items-center transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
        SCOPE_PILL_SHAPE,
        provider.enabled ? tone.pillOn : tone.pillOff,
      )}
    >
      <HarnessIcon
        harnessId={provider.harness}
        className={cn("size-3.5", !provider.enabled && "opacity-60")}
      />
      <span className="min-w-0 truncate">{provider.name}</span>
      {count !== null ? (
        <span className="tabular-nums opacity-70">{count}</span>
      ) : null}
    </button>
  );
}

/**
 * How many repos the submission actually brings over.
 *
 * Every other number on the event describes the import, so this one has to as
 * well. `state.groups.length` counts the SCAN instead - folders the user
 * cleared outright, and folders that only ever held unreadable or
 * already-imported rows - which would read as "imported 3 sessions across 40
 * repos". The selections are the source of truth rather than `state.selected`,
 * so this cannot drift from whatever the submission decided to send.
 */
function pillCountLabel(count: number, pending: boolean): string | null {
  if (count > 0) return count.toLocaleString();
  return pending ? null : "0";
}

function submittedGroupCount(
  groups: ReadonlyArray<SessionImportGroup>,
  selections: ReadonlyArray<SessionImportSelection>,
): number {
  const submitted = new Set(
    selections.map((selection) =>
      sessionImportSelectionKey(selection.harness, selection.nativeSessionId),
    ),
  );
  return groups.filter((group) =>
    group.sessions.some((candidate) =>
      submitted.has(
        sessionImportSelectionKey(candidate.harness, candidate.nativeSessionId),
      ),
    ),
  ).length;
}

function emptyMessage(
  state: SessionImportWizardState,
  view: SessionImportWizardView,
): string {
  if (state.phase === "failed") return "Couldn’t read task folders.";
  if (view.hiddenImportedCount > 0 && state.importedSupport === "supported")
    return "All matching tasks are already imported.";
  if (view.totalSessions === 0) {
    // A bounded scan finding nothing is not "you have no work" - the window
    // picker above can look further back, and the copy points at it.
    return state.scanWindow === null
      ? "No tasks found on this device."
      : `No tasks in the ${sessionImportScanWindowLabel(state.scanWindow).toLowerCase()}. Choose a longer time range.`;
  }
  if (state.query.trim().length > 0)
    return "No matching tasks. Try another search.";
  return "No tasks from the selected providers. Choose another provider.";
}

/**
 * What the wizard shows while a run owns the screen: the live progress or
 * the summary it leaves behind, over the same action row the list phase ends
 * in, so the wizard's footer stays where the hand already knows it - the
 * surface's own exit on the left, this wizard's next step on the right.
 */
function SessionImportRunView(props: {
  readonly tone: SessionImportTone;
  readonly hostId: string | null;
  readonly runStatus: SessionImportRunStatus;
  readonly secondaryAction: SessionImportSecondaryAction | null;
}) {
  const { tone, hostId, runStatus, secondaryAction } = props;
  // The tour's progress and result are centred cards, so the way back lives
  // inside the card it belongs to rather than in a bar under it - there is no
  // surface exit to pair it with there, and a lone button on a hairline was
  // the "floating mid-air" the redesign is answering.
  const runFinished =
    (runStatus === "complete" || runStatus === "error") &&
    tone.surface === "dialog";
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <SessionImportProgress tone={tone} hostId={hostId} />
      {secondaryAction !== null || runFinished ? (
        <div className="flex shrink-0 items-center justify-end gap-2 border-t px-4 py-3">
          {secondaryAction !== null ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={secondaryAction.onSelect}
            >
              {secondaryAction.label}
            </Button>
          ) : null}
          {runFinished && hostId !== null ? (
            // The way back to the list without leaving the wizard. The
            // summary holds until this is pressed - it is what the user
            // waited for, and a screen that rewrites itself on a timer would
            // pull it away mid-read. Retiring the run is all it takes: the
            // scan is paused only while a run is in flight and resumes on
            // idle, so the folder list comes back freshly read, with what
            // just landed now marked as already imported.
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="session-import-more"
              onClick={() => {
                useSessionImportRunStore.getState().reset(hostId);
              }}
            >
              {runStatus === "error" ? "Back to tasks" : "Import more"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function selectionCountLabel(
  selected: number,
  visibleSelected: number,
): string {
  const label = `${selected.toLocaleString()} ${selected === 1 ? "task" : "tasks"} selected`;
  return selected > visibleSelected
    ? `${label} · ${selected - visibleSelected} outside this view`
    : label;
}

/**
 * The master checkbox and the count it heads, shared by both surfaces' second
 * toolbar row. It reads the VISIBLE slice: it heads the list exactly as the
 * search and pills have narrowed it, so what it shows and what it moves are the
 * same rows the user is looking at.
 */
function SessionImportSelectAll(props: {
  readonly view: SessionImportWizardView;
  readonly tone: SessionImportTone;
  readonly dispatch: SessionImportScanHandle["dispatch"];
  readonly countLabel: string | null;
}) {
  const { view, tone, dispatch, countLabel } = props;
  const visibleSelection = selectionStateFor(
    view.visibleSelectionKeys.length,
    view.visibleSelectedCount,
  );
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        role="checkbox"
        aria-checked={
          visibleSelection === "partial" ? "mixed" : visibleSelection === "all"
        }
        aria-label="Select all available tasks shown"
        data-testid="session-import-visible-selection"
        disabled={view.visibleSelectionKeys.length === 0}
        onClick={() =>
          dispatch({
            kind: "visibleSelectionSet",
            selectionKeys: view.visibleSelectionKeys,
            selected: visibleSelection !== "all",
          })
        }
        className={cn(
          "flex shrink-0 items-center rounded-md border-x border-transparent px-2.5 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
          view.visibleSelectionKeys.length > 0 && tone.rowHover,
        )}
      >
        <SelectionBox
          state={visibleSelection}
          disabled={view.visibleSelectionKeys.length === 0}
          tone={tone}
        />
      </button>
      {countLabel !== null ? (
        <span
          data-testid="session-import-selection-count"
          className={cn(
            "text-ui-xs tabular-nums whitespace-nowrap",
            tone.muted,
          )}
        >
          {countLabel}
        </span>
      ) : null}
    </div>
  );
}

function SessionImportSelectionToolbar(props: {
  readonly view: SessionImportWizardView;
  readonly tone: SessionImportTone;
  readonly dispatch: SessionImportScanHandle["dispatch"];
}) {
  const { view, tone, dispatch } = props;
  return view.groups.length > 0 && view.selectableSessions > 0 ? (
    <div className="session-import-selection flex shrink-0 flex-wrap items-center justify-between gap-2 px-4 pt-2">
      <SessionImportSelectAll
        view={view}
        tone={tone}
        dispatch={dispatch}
        countLabel={selectionCountLabel(
          view.selectedCount,
          view.visibleSelectedCount,
        )}
      />
    </div>
  ) : null;
}

/**
 * The tour's own toolbar, in two rows with two jobs. Row one is the SCOPE -
 * which machine, which words, how far back, whether imported work counts. Row
 * two is the SELECTION - how much of what row one turned up is ticked, which
 * providers it is drawn from, and how it is arranged. The Settings dialog keeps
 * its own one-column arrangement above; nothing here reaches it.
 */
function SessionImportOnboardingToolbar(props: {
  readonly hostPicker: ReactNode;
  readonly tone: SessionImportTone;
  readonly view: SessionImportWizardView;
  readonly dispatch: SessionImportScanHandle["dispatch"];
  readonly query: string;
  readonly providers: ReadonlyArray<SessionImportProviderView>;
  readonly scanning: boolean;
  readonly scanWindow: SessionImportScanWindow;
  readonly showImported: boolean;
  readonly importedSupport: SessionImportImportedSupport;
  readonly groupByProject: boolean;
  readonly setGroupByProject: (grouped: boolean) => void;
  readonly onShowImportedChange: (showImported: boolean) => void;
  readonly onQueryChange: (query: string) => void;
  readonly onToggleProvider: (harness: GuiHarnessId) => void;
  readonly onScanWindowChange: (window: SessionImportScanWindow) => void;
}) {
  const { tone, view, providers, scanning, groupByProject } = props;
  const viewControlId = useId();
  return (
    <div className="onboarding-import-toolbar flex shrink-0 flex-col gap-2.5">
      <div className="onboarding-import-toolbar-scope flex min-w-0 items-center gap-2">
        {props.hostPicker}
        <div className="onboarding-import-search relative min-w-0 flex-1">
          <Search
            aria-hidden
            className={cn(
              "pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2",
              tone.faint,
            )}
          />
          <Input
            type="search"
            value={props.query}
            aria-label="Search work"
            placeholder="Search tasks or folders"
            data-testid="session-import-search"
            onChange={(event) => props.onQueryChange(event.target.value)}
            className="h-8 pl-10"
            size="sm"
          />
        </div>
        <ScanWindowSelect
          tone={tone}
          scanWindow={props.scanWindow}
          onChange={props.onScanWindowChange}
        />
        <ImportedVisibilityToggle
          tone={tone}
          showImported={props.showImported}
          support={props.importedSupport}
          onChange={props.onShowImportedChange}
        />
      </div>
      <div className="onboarding-import-selection flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 pb-2">
        <SessionImportSelectAll
          view={view}
          tone={tone}
          dispatch={props.dispatch}
          countLabel={
            view.selectableSessions > 0
              ? `${view.selectedCount.toLocaleString()} of ${view.selectableSessions.toLocaleString()} selected`
              : null
          }
        />
        {/* On a phone this run scrolls sideways instead of wrapping - see
            onboarding-import.css. */}
        <div className="onboarding-import-pills flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {providers.map((provider) => (
            <ProviderPill
              key={provider.harness}
              provider={provider}
              pending={scanning}
              tone={tone}
              onToggle={props.onToggleProvider}
            />
          ))}
        </div>
        <fieldset
          aria-label="Import view"
          role="radiogroup"
          className="onboarding-import-view-toggle flex shrink-0 gap-0.5 rounded-lg bg-foreground/5 p-0.5"
        >
          {[
            { label: "Tasks", grouped: false },
            { label: "By project", grouped: true },
          ].map((option) => (
            <label key={option.label} className="cursor-pointer">
              <input
                type="radio"
                name={viewControlId}
                checked={groupByProject === option.grouped}
                onChange={() => props.setGroupByProject(option.grouped)}
                className="peer sr-only"
              />
              <span className="block rounded-md px-3 py-1 text-ui-xs text-muted-foreground transition-colors peer-checked:bg-foreground/10 peer-checked:text-foreground peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring peer-focus-visible:transition-none motion-reduce:transition-none">
                {option.label}
              </span>
            </label>
          ))}
        </fieldset>
      </div>
    </div>
  );
}
