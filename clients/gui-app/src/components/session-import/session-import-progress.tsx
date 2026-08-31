import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { cn } from "@/lib/utils";
import {
  groupSessionImportFailures,
  type SessionImportFailureGroupView,
} from "@/components/session-import/session-import-model";
import type {
  SessionImportSurface,
  SessionImportTone,
} from "@/components/session-import/session-import-tone";
import {
  sessionImportDoneCount,
  sessionImportIsRunning,
  sessionImportRunCounts,
  useSessionImportRunStore,
} from "@/stores/session-import/session-import-run-store";

/**
 * What the wizard shows once a run is under way, and the summary it leaves
 * behind. Reads the run store rather than props because the same view has to
 * be correct when the wizard is closed and reopened mid-run - the progress it
 * shows is the run's, not this mount's.
 */
export function SessionImportProgress(props: {
  readonly tone: SessionImportTone;
}) {
  const { tone } = props;
  // The selector returns only values the store itself owns - a derived array or
  // counts object minted per call would fail `useShallow`'s equality every
  // time, which `useSyncExternalStore` rejects as an uncached snapshot.
  const run = useSessionImportRunStore(
    useShallow((state) => ({
      status: state.status,
      total: state.total,
      done: sessionImportDoneCount(state),
      lastTitle: state.lastTitle,
      running: sessionImportIsRunning(state),
      attached: state.attached,
      outcomes: state.outcomes,
      titles: state.titles,
      finalCounts: state.finalCounts,
    })),
  );
  const counts = useMemo(
    () =>
      sessionImportRunCounts({
        outcomes: run.outcomes,
        finalCounts: run.finalCounts,
      }),
    [run.finalCounts, run.outcomes],
  );
  const failures = useMemo(
    () => groupSessionImportFailures([...run.outcomes.values()], run.titles),
    [run.outcomes, run.titles],
  );

  if (run.running) {
    // `role="status"` (a polite live region by definition) because everything
    // that moves in this view is text: the count, the session being worked on,
    // and the notice that says whose run this is. Without it a screen reader is
    // told an import started and then hears nothing more.
    return (
      <div
        role="status"
        data-testid="session-import-progress"
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 py-10 text-center"
      >
        <AgentSpinningDots
          className={tone.muted}
          testId="session-import-progress-spinner"
          variant={undefined}
        />
        <p className={cn("text-ui-sm font-medium", tone.strong)}>
          Importing {run.done} of {run.total}…
        </p>
        {run.lastTitle !== null ? (
          <p className={cn("max-w-md truncate text-ui-xs", tone.faint)}>
            {run.lastTitle}
          </p>
        ) : null}
        {run.attached ? (
          <p
            data-testid="session-import-progress-attached"
            className={cn("max-w-md text-ui-xs", tone.muted)}
          >
            An import was already running - showing its progress. Your selection
            was not started.
          </p>
        ) : null}
        <p className={cn("text-ui-xs", tone.muted)}>
          You can close this. The import keeps running.
        </p>
      </div>
    );
  }

  if (run.status === "error") {
    return (
      <div
        data-testid="session-import-progress-error"
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 py-10 text-center"
      >
        <p className={cn("text-ui-sm font-medium", tone.strong)}>
          Traycer lost track of the import
        </p>
        <p className={cn("max-w-md text-ui-xs", tone.muted)}>
          It may still be running on your machine. Reopen this from Settings to
          check.
        </p>
      </div>
    );
  }

  return (
    <div
      data-testid="session-import-summary"
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-6"
    >
      {/* Centered only when the run ended clean: over left-aligned failure
          cards a centered headline reads as two layouts on one screen. */}
      <div
        className={cn(
          "flex flex-col gap-1",
          failures.length === 0 && "items-center text-center",
        )}
      >
        <p className={cn("text-ui-sm font-medium", tone.strong)}>
          {counts.imported === 0
            ? "Nothing was imported"
            : `Imported ${counts.imported} ${counts.imported === 1 ? "session" : "sessions"}`}
        </p>
        <p className={cn("text-ui-xs", tone.muted)}>
          {summaryLine(
            counts.skippedAlreadyImported,
            counts.failed,
            tone.surface,
          )}
        </p>
      </div>
      {failures.map((group) => (
        <FailureGroup key={group.reason} group={group} tone={tone} />
      ))}
    </div>
  );
}

function summaryLine(
  skipped: number,
  failed: number,
  surface: SessionImportSurface,
): string {
  const parts: string[] = [];
  if (skipped > 0) parts.push(`${skipped} already in Traycer`);
  if (failed > 0) parts.push(`${failed} could not be imported`);
  if (parts.length > 0) return parts.join(" · ");
  // Mid-tour there is no task list to point at yet - it is behind the acts the
  // user has not reached.
  return surface === "onboarding"
    ? "They'll be in your task list when you finish the tour."
    : "Your tasks are in the list on the left.";
}

function FailureGroup(props: {
  readonly group: SessionImportFailureGroupView;
  readonly tone: SessionImportTone;
}) {
  const { group, tone } = props;
  return (
    <div
      data-testid="session-import-failure-group"
      data-reason={group.reason}
      className={cn("flex flex-col gap-1 rounded-lg border p-3", tone.border)}
    >
      <p className={cn("text-ui-xs font-medium", tone.strong)}>
        {group.label} ({group.entries.length})
      </p>
      <ul className="flex flex-col gap-1">
        {group.entries.map((entry) => (
          <li
            key={entry.selectionKey}
            className="flex min-w-0 items-baseline gap-2"
          >
            <span className={cn("min-w-0 truncate text-ui-xs", tone.muted)}>
              {entry.title}
            </span>
            <span
              className={cn("min-w-0 flex-1 truncate text-ui-xs", tone.faint)}
            >
              {entry.detail}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
