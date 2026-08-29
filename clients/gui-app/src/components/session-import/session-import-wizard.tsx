import { useEffect, useMemo } from "react";
import { History, Search } from "lucide-react";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type {
  SessionImportGroup,
  SessionImportSelection,
} from "@traycer/protocol/host/session-import/candidate";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { Input } from "@/components/ui/input";
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
} from "@/components/session-import/session-import-group";
import { SessionImportProgress } from "@/components/session-import/session-import-progress";
import { useSessionImportScan } from "@/components/session-import/use-session-import-scan";
import { startSessionImportRun } from "@/components/session-import/session-import-run-handle";
import {
  sessionImportTone,
  type SessionImportTone,
  type SessionImportSurface,
} from "@/components/session-import/session-import-tone";
import { useSessionImportRunStore } from "@/stores/session-import/session-import-run-store";

export interface SessionImportSecondaryAction {
  readonly label: string;
  readonly onSelect: () => void;
}

/**
 * The one import surface, used by the onboarding act and the Settings dialog
 * alike (spec D3). It scans while it is open, never before (D13), and hands the
 * user's selection to the app-wide run controller rather than owning the run
 * itself - which is what lets it be closed mid-import.
 *
 * The two surfaces differ in who presses go. The dialog owns its own "Import"
 * button; the tour has exactly one forward control, so the act's Continue
 * submits through `registerSubmit` and a second button beside it would be a
 * second way to do the same thing.
 */
export function SessionImportWizard(props: {
  readonly surface: SessionImportSurface;
  /** Called once a run has been submitted, so the caller can move on. */
  readonly onImportStarted: () => void;
  readonly secondaryAction: SessionImportSecondaryAction | null;
  /**
   * Hands the caller the wizard's submit, for a surface whose go-button lives
   * outside it. Null on a surface that submits itself.
   */
  readonly registerSubmit: ((submit: () => void) => void) | null;
}) {
  const { surface, onImportStarted, secondaryAction, registerSubmit } = props;
  const tone = sessionImportTone(surface);
  const runStatus = useSessionImportRunStore((state) => state.status);
  const runIdle = runStatus === "idle";

  // Opening the wizard retires a FINISHED run's summary, so a second visit
  // scans afresh instead of re-reading last time's result. Mount-only on
  // purpose: a run that finishes while this is open still shows its summary,
  // because that summary is what the user is waiting for.
  useEffect(() => {
    const run = useSessionImportRunStore.getState();
    if (run.status === "complete" || run.status === "error") run.reset();
  }, []);

  const { state, dispatch } = useSessionImportScan(runIdle);
  const view = useMemo(() => buildSessionImportView(state), [state]);
  // The master checkbox reads the VISIBLE slice: it heads the list exactly as
  // the search and pills have narrowed it, so what it shows and what it moves
  // are the same rows the user is looking at.
  const visibleSelection = selectionStateFor(
    view.visibleSelectionKeys.length,
    view.visibleSelectedCount,
  );

  const submit = (): void => {
    // A run already under way owns the screen; Continue during one is the user
    // moving on, not a second import.
    if (!runIdle) return;
    const submission = buildSessionImportSubmission(state);
    if (submission.selections.length === 0) return;
    Analytics.getInstance().track(AnalyticsEvent.SessionImportStarted, {
      surface,
      session_count: submission.selections.length,
      group_count: submittedGroupCount(state.groups, submission.selections),
    });
    startSessionImportRun(submission);
    onImportStarted();
  };

  // Re-registered on every render, deliberately: the caller presses Continue
  // long after this runs, and it has to submit the selection as it stands then,
  // not the one this mount opened with.
  useEffect(() => {
    if (registerSubmit === null) return;
    registerSubmit(submit);
  });

  if (!runIdle) {
    return (
      <div className="flex min-h-0 w-full flex-1 flex-col">
        <SessionImportProgress tone={tone} />
        {secondaryAction !== null ? (
          <div className="flex shrink-0 justify-end px-4 py-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={secondaryAction.onSelect}
            >
              {secondaryAction.label}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <SessionImportFilters
        tone={tone}
        query={state.query}
        providers={view.providers}
        scanning={state.phase === "scanning"}
        scanWindow={state.scanWindow}
        onQueryChange={(query) => dispatch({ kind: "queryChanged", query })}
        onToggleProvider={(harness) =>
          dispatch({ kind: "providerScopeToggled", harness })
        }
        onScanWindowChange={(window) =>
          dispatch({ kind: "windowChanged", window })
        }
      />

      {view.groups.length > 0 ? (
        <div className="flex shrink-0 items-center gap-1 px-4 pt-2">
          <button
            type="button"
            role="checkbox"
            aria-checked={
              visibleSelection === "partial"
                ? "mixed"
                : visibleSelection === "all"
            }
            aria-label="Select all listed work"
            data-testid="session-import-visible-selection"
            disabled={view.visibleSelectionKeys.length === 0}
            onClick={() =>
              dispatch({
                kind: "visibleSelectionSet",
                selectionKeys: view.visibleSelectionKeys,
                selected: visibleSelection !== "all",
              })
            }
            // The transparent side borders mirror the cards' own border, so
            // this box heads exactly the column the folder checkboxes below
            // sit on - which is also what makes its reach legible: it rules
            // the rows under it, as the search and pills have narrowed them.
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
          {view.selectableSessions > 0 ? (
            <span
              data-testid="session-import-selection-count"
              className={cn("text-ui-xs tabular-nums", tone.faint)}
            >
              {view.selectedCount.toLocaleString()} of{" "}
              {view.selectableSessions.toLocaleString()} selected
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-4 py-3">
        {state.scanErrorDetail !== null ? (
          <p
            data-testid="session-import-scan-error"
            className={cn(
              "shrink-0 rounded-md px-2.5 py-1.5 text-ui-xs",
              tone.warningSurface,
            )}
          >
            The scan stopped before it finished. {state.scanErrorDetail}
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
            Your {harnessDisplayName(failure.harness)} work could not be read.{" "}
            {failure.detail}
          </p>
        ))}

        {view.groups.map((group) => (
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
            onToggleSession={(selectionKey) =>
              dispatch({ kind: "sessionToggled", selectionKey })
            }
          />
        ))}
        {state.phase === "scanning" ? (
          // px-2.5 sits the spinner on the same column as the checkboxes in
          // the cards above it.
          <div className="flex shrink-0 items-center gap-2 px-2.5 py-2">
            <AgentSpinningDots
              className={tone.faint}
              testId="session-import-scan-spinner"
              variant={undefined}
            />
            <span className={cn("text-ui-xs", tone.faint)}>
              Looking for your work on this machine…
              {view.totalSessions > 0
                ? ` ${view.totalSessions.toLocaleString()} found so far`
                : ""}
            </span>
          </div>
        ) : null}
        {state.phase !== "scanning" && view.groups.length === 0 ? (
          <p
            data-testid="session-import-empty"
            className={cn(
              "mx-auto max-w-[26rem] px-1 py-10 text-center text-ui-sm",
              tone.muted,
            )}
          >
            {emptyMessage(state, view)}
          </p>
        ) : null}
      </div>

      <SessionImportFooter
        tone={tone}
        view={view}
        secondaryAction={secondaryAction}
        // The surface that hands its submit to a caller has no button of its
        // own; the one that keeps it renders it here.
        onSubmit={registerSubmit === null ? submit : null}
      />
    </div>
  );
}

/**
 * The pinned header: search over everything, the scan-window picker, one pill
 * per provider the scan covers.
 */
function SessionImportFilters(props: {
  readonly tone: SessionImportTone;
  readonly query: string;
  readonly providers: ReadonlyArray<SessionImportProviderView>;
  readonly scanning: boolean;
  readonly scanWindow: SessionImportScanWindow;
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
        "flex shrink-0 flex-col gap-2 border-b px-4 py-3",
        tone.border,
      )}
    >
      <div className="relative min-w-0">
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
          placeholder="Search work or folders"
          data-testid="session-import-search"
          onChange={(event) => onQueryChange(event.target.value)}
          className="h-8 pl-8 text-ui-sm"
        />
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
      </div>
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
 * count and the master checkbox live at the head of the list they describe, so
 * a surface with no button of its own (the tour, whose Continue lives outside)
 * has no footer at all.
 */
function SessionImportFooter(props: {
  readonly tone: SessionImportTone;
  readonly view: SessionImportWizardView;
  readonly secondaryAction: SessionImportSecondaryAction | null;
  readonly onSubmit: (() => void) | null;
}) {
  const { tone, view, secondaryAction, onSubmit } = props;
  if (secondaryAction === null && onSubmit === null) return null;
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-end gap-2 border-t px-4 py-3",
        tone.border,
      )}
    >
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
      {onSubmit !== null ? (
        <Button
          type="button"
          size="sm"
          data-testid="session-import-submit"
          disabled={view.selectedCount === 0}
          onClick={onSubmit}
        >
          Import {view.selectedCount}{" "}
          {view.selectedCount === 1 ? "session" : "sessions"}
        </Button>
      ) : null}
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
  const count =
    provider.count > 0
      ? provider.count.toLocaleString()
      : pending
        ? null
        : "0";
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
  if (state.phase === "failed")
    return "Traycer could not read your work folders.";
  if (view.totalSessions === 0) {
    // A bounded scan finding nothing is not "you have no work" - the window
    // picker above can look further back, and the copy points at it.
    return state.scanWindow === null
      ? "No work from Claude Code, Codex, or OpenCode found on this machine."
      : `No work from Claude Code, Codex, or OpenCode in the ${sessionImportScanWindowLabel(state.scanWindow).toLowerCase()}. Pick a longer window to look further back.`;
  }
  if (state.query.trim().length > 0) return "No work matches your search.";
  return "No work from the providers you picked.";
}
