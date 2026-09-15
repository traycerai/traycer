import { useEffect, useMemo, type ReactNode } from "react";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { WelcomeModalFooter } from "@/components/onboarding/welcome/welcome-modal-footer";
import type { WelcomeHostImportRun } from "@/components/onboarding/welcome/use-welcome-host-import-run";
import type { WelcomeScan } from "@/components/onboarding/welcome/use-welcome-scan";
import {
  buildWelcomeSessionsView,
  groupImportableKeys,
  welcomeSessionsBranch,
  type WelcomeProviderSection,
  type WelcomeSessionsView,
} from "@/components/onboarding/welcome/welcome-sessions-model";
import {
  SelectionBox,
  SessionImportGroupItem,
} from "@/components/session-import/session-import-group";
import {
  buildSessionImportSubmission,
  harnessDisplayName,
  sessionImportScanWindowLabel,
  submittedGroupCount,
  type SessionImportScanWindow,
  type SessionImportWizardAction,
  type SessionImportWizardState,
} from "@/components/session-import/session-import-model";
import { startSessionImportRun } from "@/components/session-import/session-import-run-handle";
import {
  sessionImportTone,
  type SessionImportTone,
} from "@/components/session-import/session-import-tone";
import { ScanWindowSelect } from "@/components/session-import/session-import-wizard";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { useStreamRuntimeBinding } from "@/lib/host/stream-runtime-context";
import { cn } from "@/lib/utils";
import { useFeatureAnnouncementsStore } from "@/stores/settings/feature-announcements-store";

// The list fades its bottom edge rather than slicing a row against the
// footer's border: with the rows filling the page, a hard cut read as the end
// of the list, not as more below (`mobile-nav-drawer` does the same). The
// scroller carries matching bottom padding, so the gradient only ever
// covers blank space - at full scroll the last row stays crisp.
const LIST_FADE_CLASS =
  "[-webkit-mask-image:linear-gradient(to_bottom,black_calc(100%-2rem),transparent)] [mask-image:linear-gradient(to_bottom,black_calc(100%-2rem),transparent)]";

/**
 * Page 2 of the welcome modal: the sessions the background scan found,
 * grouped provider → folder → session with a three-state checkbox at every
 * level, and the Import / Skip import choice.
 *
 * The scan is the modal's (`useWelcomeScan`, running since the modal
 * opened), and so is the host's import status (`useWelcomeHostImportRun`,
 * because the header's copy reads it too); this page only projects their
 * state (`welcome-sessions-model`) and dispatches the wizard reducer's
 * existing actions. Every exit is a
 * callback - the modal writes the flow store and decides the branch - and
 * nothing here renders import progress: Import hands the selection to the
 * app-wide run controller and reports, and the progress toast takes over
 * once the modal is gone.
 *
 * Reaching this page IS the session-import announcement (parent contract
 * 2), so the release toast never follows a user who saw it - while a user
 * who skipped before it still gets one.
 */
export function WelcomeSessionsPage(props: {
  readonly welcomeScan: WelcomeScan;
  readonly hostImportRun: WelcomeHostImportRun;
  /** Called right after `startSessionImportRun`; the modal finishes as `sessions`. */
  readonly onImportStarted: () => void;
  readonly onSkipImport: () => void;
  /** The scan settled with nothing importable, or the host cannot scan. */
  readonly onNoSessions: () => void;
  /** An import is already running on this host; the modal finishes as `sessions`. */
  readonly onAlreadyRunningContinue: () => void;
}): ReactNode {
  const {
    welcomeScan,
    hostImportRun,
    onImportStarted,
    onSkipImport,
    onNoSessions,
    onAlreadyRunningContinue,
  } = props;
  const tone = sessionImportTone("welcome-modal");
  const consumeAnnouncement = useFeatureAnnouncementsStore(
    (state) => state.consume,
  );
  useEffect(() => {
    consumeAnnouncement("session-import");
  }, [consumeAnnouncement]);

  // The run this page starts is aimed at the host it renders under - the
  // stream binding names transport and machine together, the same binding
  // the scan is reading (`session-import-wizard.tsx` does the same).
  const streamBinding = useStreamRuntimeBinding();
  const { alreadyRunning, canSubmit, checkingStatus, statusQuery } =
    hostImportRun;

  const { state, dispatch } = welcomeScan.scan;
  const view = useMemo(() => buildWelcomeSessionsView(state), [state]);
  const branch = welcomeSessionsBranch({
    alreadyRunning,
    support: welcomeScan.support,
    phase: state.phase,
    view,
  });

  const submit = (): void => {
    if (!canSubmit) return;
    const submission = buildSessionImportSubmission(state);
    if (submission.selections.length === 0) return;
    const sessionCount = submission.selections.length;
    Analytics.getInstance().track(AnalyticsEvent.SessionImportStarted, {
      surface: "welcome-modal",
      session_count: sessionCount,
      group_count: submittedGroupCount(state.groups, submission.selections),
    });
    Analytics.getInstance().track(AnalyticsEvent.OnboardingModalContinued, {
      page: "2",
      enabled_provider_count: welcomeScan.providers.length,
      session_count: sessionCount,
    });
    startSessionImportRun(submission, streamBinding);
    onImportStarted();
  };

  if (branch === "already-running") {
    return (
      <>
        <WelcomeSessionsNotice testId="welcome-sessions-already-running">
          An import is already running on this machine. You can pick up where it
          leaves off in your task list.
        </WelcomeSessionsNotice>
        <WelcomeModalFooter
          leading={null}
          secondary={null}
          primary={{
            label: "Continue",
            onSelect: onAlreadyRunningContinue,
            disabled: false,
            pending: false,
          }}
        />
      </>
    );
  }

  if (branch === "unsupported") {
    return (
      <>
        <WelcomeSessionsNotice testId="welcome-sessions-unsupported">
          This machine can&apos;t import sessions.
        </WelcomeSessionsNotice>
        <WelcomeModalFooter
          leading={null}
          secondary={null}
          primary={{
            label: "Continue",
            onSelect: onNoSessions,
            disabled: false,
            pending: false,
          }}
        />
      </>
    );
  }

  const windowSelect = (
    <ScanWindowSelect
      tone={tone}
      scanWindow={state.scanWindow}
      onChange={(window) => dispatch({ kind: "windowChanged", window })}
    />
  );

  // Nothing on screen yet. The picker is there from the start, so a scan
  // window that turns out too narrow can be widened without waiting.
  if (branch === "waiting") {
    return (
      <>
        <div
          data-testid="welcome-sessions-page"
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 py-4"
        >
          <ScanningLine tone={tone} found={0} />
        </div>
        <WelcomeModalFooter
          leading={welcomeScan.support === "supported" ? windowSelect : null}
          secondary={{ label: "Skip import", onSelect: onSkipImport }}
          primary={{
            label: importLabel(0),
            onSelect: submit,
            disabled: true,
            pending: false,
          }}
        />
      </>
    );
  }

  // Settled with nothing to tick. One way out - and the picker, which is
  // the one control that can change the answer.
  if (branch === "empty") {
    return (
      <>
        <div
          data-testid="welcome-sessions-page"
          className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-6 py-4"
        >
          <ScanErrorBanner state={state} tone={tone} />
          {view.sections
            .filter((section) => section.failure !== null)
            .map((section) => (
              <ProviderFailureBanner
                key={section.harness}
                section={section}
                tone={tone}
              />
            ))}
          <p
            data-testid="welcome-sessions-empty"
            className={cn(
              "mx-auto max-w-[26rem] px-1 py-10 text-center text-ui-sm",
              tone.muted,
            )}
          >
            {emptyMessage(state, welcomeScan)}
          </p>
        </div>
        <WelcomeModalFooter
          leading={windowSelect}
          secondary={null}
          primary={{
            label: "Continue",
            onSelect: onNoSessions,
            disabled: false,
            pending: false,
          }}
        />
      </>
    );
  }

  return (
    <>
      <div
        data-testid="welcome-sessions-page"
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-6 pt-4 pb-8",
          LIST_FADE_CLASS,
        )}
      >
        <ScanErrorBanner state={state} tone={tone} />
        {view.sections.map((section) => (
          <WelcomeProviderSectionCard
            key={section.harness}
            section={section}
            scanning={state.phase === "scanning"}
            scanWindow={state.scanWindow}
            tone={tone}
            dispatch={dispatch}
          />
        ))}
        {state.phase === "scanning" ? (
          <ScanningLine tone={tone} found={view.totalSessions} />
        ) : null}
      </div>
      {statusQuery.isError ? (
        <div role="alert" className="flex items-center gap-2 px-6 py-2">
          <p className={cn("text-ui-xs", tone.muted)}>
            Traycer could not check whether an import is already running.
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
      <WelcomeModalFooter
        leading={
          <>
            {windowSelect}
            <SelectionCount view={view} tone={tone} />
          </>
        }
        secondary={{ label: "Skip import", onSelect: onSkipImport }}
        primary={{
          label: importLabel(view.selectedCount),
          onSelect: submit,
          disabled: !canSubmit || view.selectedCount === 0,
          pending: checkingStatus,
        }}
      />
    </>
  );
}

function importLabel(count: number): string {
  return `Import ${count.toLocaleString()} ${count === 1 ? "task" : "tasks"}`;
}

/**
 * One provider's card: a header that is the provider-level checkbox, then
 * one folder group per folder this provider has work in. A provider the
 * scan covered but found nothing for keeps its card, header only - the user
 * should see what was looked at, not wonder whether it was. A failed reader
 * adds its banner above the groups it still has, if any.
 */
function WelcomeProviderSectionCard(props: {
  readonly section: WelcomeProviderSection;
  readonly scanning: boolean;
  readonly scanWindow: SessionImportScanWindow;
  readonly tone: SessionImportTone;
  readonly dispatch: (action: SessionImportWizardAction) => void;
}): ReactNode {
  const { section, scanning, scanWindow, tone, dispatch } = props;
  const selectable = section.selectableCount > 0;
  const label = sectionSelectionLabel(section);
  return (
    <section
      data-testid="welcome-sessions-section"
      data-harness={section.harness}
      aria-label={section.name}
      className={cn(
        "flex shrink-0 flex-col overflow-hidden rounded-lg border",
        tone.border,
      )}
    >
      <div
        className={cn("flex w-full min-w-0 items-center", tone.groupSurface)}
      >
        <button
          type="button"
          role="checkbox"
          aria-checked={
            section.selectionState === "partial"
              ? "mixed"
              : section.selectionState === "all"
          }
          aria-label={`${section.name}: ${label}`}
          disabled={!selectable}
          data-testid="welcome-sessions-section-select"
          onClick={() =>
            dispatch({
              kind: "visibleSelectionSet",
              selectionKeys: section.importableKeys,
              selected: section.selectionState !== "all",
            })
          }
          className={cn(
            "flex shrink-0 items-center rounded-md p-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
            selectable && tone.rowHover,
          )}
        >
          <SelectionBox
            state={section.selectionState}
            disabled={!selectable}
            tone={tone}
          />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-2.5 py-2.5 pr-3">
          <HarnessIcon harnessId={section.harness} className="size-4" />
          <span
            className={cn(
              "min-w-0 truncate text-ui-sm font-medium",
              tone.strong,
            )}
          >
            {section.name}
          </span>
          <span
            data-testid="welcome-sessions-section-count"
            className={cn(
              "ml-auto shrink-0 text-ui-xs tabular-nums",
              tone.muted,
            )}
          >
            {sectionCountLabel(section, scanning, scanWindow)}
          </span>
        </div>
      </div>
      {section.failure !== null || section.groups.length > 0 ? (
        <div
          className={cn(
            "flex flex-col gap-2 border-t py-2 pr-2 pl-3",
            tone.border,
          )}
        >
          {/* The banner sits ABOVE whatever this provider still has, never
              in place of it: a same-host reconnect keeps the groups and
              ticks from the earlier pass in the reducer, and those rows
              are still what Import submits - hiding them behind the banner
              would import work the user could no longer see or untick. */}
          {section.failure !== null ? (
            <ProviderFailureBanner section={section} tone={tone} />
          ) : null}
          {section.groups.map((group) => (
            <SessionImportGroupItem
              key={group.groupKey}
              group={group}
              tone={tone}
              onToggleExpanded={(groupKey) =>
                dispatch({ kind: "groupExpansionToggled", groupKey })
              }
              // This group's own keys, never `groupSelectionSet`: the wizard's
              // folder key spans every provider in the folder, and this card
              // is one provider's slice of it.
              onSetGroupSelection={(_groupKey, selected) =>
                dispatch({
                  kind: "visibleSelectionSet",
                  selectionKeys: groupImportableKeys(group),
                  selected,
                })
              }
              onToggleSession={(selectionKey) =>
                dispatch({ kind: "sessionToggled", selectionKey })
              }
              // No imported rows are shown here, so the open-task button
              // never renders and these are never called.
              onTaskOpened={() => {}}
              onBeforeTaskOpen={null}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function sectionSelectionLabel(section: WelcomeProviderSection): string {
  const count = section.selectableCount.toLocaleString();
  const noun = section.selectableCount === 1 ? "task" : "tasks";
  if (section.selectionState === "none")
    return `Select ${count} available ${noun}`;
  if (section.selectionState === "all")
    return `All ${count} available ${noun} selected`;
  return `${section.selectedCount.toLocaleString()} of ${count} available ${noun} selected`;
}

/**
 * The header's right-hand count. A provider with rows counts its ticks; one
 * with none says so only once the scan has settled - a mid-scan zero means
 * "not yet", not "nothing" - and a failed one leaves the line to its banner.
 */
function sectionCountLabel(
  section: WelcomeProviderSection,
  scanning: boolean,
  scanWindow: SessionImportScanWindow,
): string {
  if (section.groups.length > 0) {
    return `${section.selectedCount.toLocaleString()} of ${section.selectableCount.toLocaleString()} selected`;
  }
  if (section.failure !== null || scanning) return "";
  return scanWindow === null
    ? "nothing found"
    : `nothing in the ${sessionImportScanWindowLabel(scanWindow).toLowerCase()}`;
}

function ProviderFailureBanner(props: {
  readonly section: WelcomeProviderSection;
  readonly tone: SessionImportTone;
}): ReactNode {
  const { section, tone } = props;
  return (
    <p
      data-testid="welcome-sessions-provider-failure"
      data-harness={section.harness}
      className={cn(
        "shrink-0 rounded-md px-2.5 py-1.5 text-ui-xs",
        tone.warningSurface,
      )}
    >
      Your {section.name} work could not be read. {section.failure}
    </p>
  );
}

function ScanErrorBanner(props: {
  readonly state: SessionImportWizardState;
  readonly tone: SessionImportTone;
}): ReactNode {
  const { state, tone } = props;
  if (state.scanErrorDetail === null) return null;
  return (
    <p
      data-testid="welcome-sessions-scan-error"
      className={cn(
        "shrink-0 rounded-md px-2.5 py-1.5 text-ui-xs",
        tone.warningSurface,
      )}
    >
      The scan stopped before it finished. {state.scanErrorDetail}
    </p>
  );
}

function ScanningLine(props: {
  readonly tone: SessionImportTone;
  readonly found: number;
}): ReactNode {
  const { tone, found } = props;
  return (
    <div className="flex shrink-0 items-center gap-2 px-2.5 py-2">
      <AgentSpinningDots
        className={tone.faint}
        testId="welcome-sessions-scan-spinner"
        variant={undefined}
      />
      <span className={cn("text-ui-xs", tone.faint)}>
        Looking for your work on this machine…
        {found > 0 ? ` ${found.toLocaleString()} found so far` : ""}
      </span>
    </div>
  );
}

function SelectionCount(props: {
  readonly view: WelcomeSessionsView;
  readonly tone: SessionImportTone;
}): ReactNode {
  const { view, tone } = props;
  return (
    <span
      data-testid="welcome-sessions-selection-count"
      className={cn("text-ui-xs tabular-nums", tone.muted)}
    >
      {view.selectedCount.toLocaleString()}{" "}
      {view.selectedCount === 1 ? "task" : "tasks"} selected
    </span>
  );
}

/** The one-line states: a notice in the body, one primary in the footer. */
function WelcomeSessionsNotice(props: {
  readonly testId: string;
  readonly children: ReactNode;
}): ReactNode {
  const { testId, children } = props;
  return (
    <div
      data-testid="welcome-sessions-page"
      className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-4"
    >
      <p
        data-testid={testId}
        className="max-w-[26rem] text-center text-ui-sm text-muted-foreground"
      >
        {children}
      </p>
    </div>
  );
}

/**
 * Names the providers that were actually scanned - the roster page 1
 * narrowed the scan to - rather than every reader the host has, so "no work
 * from Codex" is never claimed about a provider that was not looked at.
 */
function emptyMessage(
  state: SessionImportWizardState,
  welcomeScan: WelcomeScan,
): string {
  if (state.phase === "failed")
    return "Traycer could not read your work folders.";
  const providers = providerList(welcomeScan);
  return state.scanWindow === null
    ? `No work from ${providers} found on this machine.`
    : `No work from ${providers} in the ${sessionImportScanWindowLabel(state.scanWindow).toLowerCase()}. Pick a longer window to look further back.`;
}

function providerList(welcomeScan: WelcomeScan): string {
  const names = welcomeScan.providers.map(harnessDisplayName);
  const last = names.at(-1);
  if (last === undefined) return "your coding agents";
  if (names.length === 1) return last;
  if (names.length === 2) return `${names[0]} or ${last}`;
  return `${names.slice(0, -1).join(", ")}, or ${last}`;
}
