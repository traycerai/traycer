import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { cn } from "@/lib/utils";
import {
  groupSessionImportFailures,
  sessionImportFailureDetailVaries,
  sessionImportNotImportedLine,
  type SessionImportFailureGroupView,
} from "@/components/session-import/session-import-model";
import type { SessionImportTone } from "@/components/session-import/session-import-tone";
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
 *
 * All three states share one centered layout, so the panel does not jump
 * between a centered spinner and a top-aligned report as the run moves on.
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
      runId: state.runId,
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
    // that moves in this view is text: the count and the session being worked
    // on. Without it a screen reader is told an import started and then hears
    // nothing more.
    return (
      <div
        role="status"
        data-testid="session-import-progress"
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 py-10 text-center"
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
          // Reached from a second window on the same machine, or by this
          // window after a reload - so the copy names the machine, not a
          // window. This window's own Import button is hidden meanwhile.
          <p
            data-testid="session-import-progress-attached"
            className={cn("max-w-md text-ui-xs", tone.muted)}
          >
            An import is already running on this machine.
          </p>
        ) : null}
      </div>
    );
  }

  if (run.status === "error") {
    // No run id means the host closed the stream before its `started` frame:
    // it refused the request, and nothing is running to keep running.
    const neverStarted = run.runId === null;
    return (
      <div
        data-testid="session-import-progress-error"
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 py-10 text-center"
      >
        <p className={cn("text-ui-sm font-medium", tone.strong)}>
          {neverStarted
            ? "The import did not start."
            : "Traycer lost connection to the host importing the tasks."}
        </p>
        <p className={cn("max-w-md text-ui-xs", tone.muted)}>
          {neverStarted
            ? "The host turned the request down before reading any session. Pick the sessions again to retry."
            : "The import keeps running on your machine."}
        </p>
      </div>
    );
  }

  return (
    <div
      data-testid="session-import-summary"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-6"
    >
      {/* `m-auto` rather than `justify-center` on the scroller: a centered
          flex child that outgrows its box loses its top edge, while auto
          margins center what fits and scroll what does not. */}
      <div className="m-auto flex w-full max-w-md flex-col items-center gap-4 text-center">
        <div className="flex flex-col gap-1">
          <p className={cn("text-ui-sm font-medium", tone.strong)}>
            {counts.imported === 0
              ? "Nothing was imported"
              : `Imported ${counts.imported} ${counts.imported === 1 ? "session" : "sessions"}`}
          </p>
          {counts.imported > 0 ? (
            // Mid-tour there is no task list to point at yet - it is behind
            // the act the user has not finished.
            <p className={cn("text-ui-xs", tone.muted)}>
              {tone.surface === "onboarding"
                ? "They'll be in your task list when you finish the tour."
                : "Your tasks are in the list on the left."}
            </p>
          ) : null}
          {counts.skippedAlreadyImported > 0 ? (
            <p className={cn("text-ui-xs", tone.muted)}>
              {counts.skippedAlreadyImported} already in Traycer
            </p>
          ) : null}
        </div>
        {failures.length > 0 ? (
          <NotImported groups={failures} tone={tone} />
        ) : null}
      </div>
    </div>
  );
}

/**
 * What did not land, as one line with one toggle: "Not imported: 6 sessions
 * with no messages". The details behind it are sectioned by cause, so a cause
 * is written once as a heading rather than once per row, and the list scrolls
 * inside a bounded height instead of pushing the headline off the panel.
 */
function NotImported(props: {
  readonly groups: ReadonlyArray<SessionImportFailureGroupView>;
  readonly tone: SessionImportTone;
}) {
  const { groups, tone } = props;
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="flex w-full min-h-0 flex-col items-center gap-2">
      <div className="flex flex-wrap items-baseline justify-center gap-x-2">
        <span
          data-testid="session-import-not-imported"
          className={cn("text-ui-xs", tone.muted)}
        >
          {sessionImportNotImportedLine(groups)}
        </span>
        <button
          type="button"
          data-testid="session-import-failure-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
          className={cn(
            "text-ui-xs underline-offset-2 hover:underline",
            tone.faint,
          )}
        >
          {expanded ? "Hide details" : "Show details"}
        </button>
      </div>
      {expanded ? (
        // Capped at roughly a third of the viewport: a long list scrolls here
        // rather than growing past the headline it explains, and the cap
        // follows the window instead of a fixed rem.
        <div
          data-testid="session-import-failure-details"
          className="flex max-h-[30vh] w-full flex-col gap-3 overflow-y-auto overscroll-contain text-left"
        >
          {groups.map((group) => (
            <section
              key={group.reason}
              data-testid="session-import-failure-group"
              data-reason={group.reason}
              className="flex flex-col gap-1"
            >
              <h4 className={cn("text-ui-xs font-medium", tone.strong)}>
                {group.label} ({group.entries.length})
              </h4>
              <ul className="flex flex-col gap-0.5">
                {group.entries.map((entry) => (
                  <li
                    key={entry.selectionKey}
                    className="flex min-w-0 items-baseline gap-2"
                  >
                    <span
                      className={cn("min-w-0 truncate text-ui-xs", tone.muted)}
                    >
                      {entry.title}
                    </span>
                    {sessionImportFailureDetailVaries(group.reason) ? (
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate text-ui-xs",
                          tone.faint,
                        )}
                      >
                        {entry.detail}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : null}
    </div>
  );
}
