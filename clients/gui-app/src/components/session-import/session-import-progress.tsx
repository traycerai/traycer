import { useMemo, useState } from "react";
import { Check, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
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
  useSessionImportRun,
  useSessionImportRunStore,
  type SessionImportRunState,
} from "@/stores/session-import/session-import-run-store";
import type { SessionImportRunCounts } from "@traycer/protocol/host/session-import/run";

/**
 * What the wizard shows once a run is under way, and the summary it leaves
 * behind. Reads the run store rather than props because the same view has to
 * be correct when the wizard is closed and reopened mid-run - the progress it
 * shows is the run's, not this mount's. The HOST is a prop: the wizard resolved
 * it from the binding it submitted on, and reading it again here would be a
 * second answer to "whose run is this".
 *
 * All three states share one centered layout, so the panel does not jump
 * between a centered spinner and a top-aligned report as the run moves on.
 */
export function SessionImportProgress(props: {
  readonly tone: SessionImportTone;
  readonly hostId: string | null;
}) {
  const { tone, hostId } = props;
  const run = useSessionImportRun(hostId);
  const running = sessionImportIsRunning(run);
  const done = sessionImportDoneCount(run);
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
  const onboarding = tone.surface === "onboarding";
  // The submitted rows, in the order they were sent, each ticked once the run
  // has reported on it. Empty when we attached to someone else's run - there
  // are no titles to list then, and the counter above carries the whole story.
  const tasks = useMemo(
    () =>
      [...run.titles.entries()].map(([selectionKey, title]) => ({
        selectionKey,
        title,
        done: run.outcomes.has(selectionKey),
      })),
    [run.outcomes, run.titles],
  );

  if (running) {
    if (onboarding) {
      return (
        <SessionImportRunningCard
          run={run}
          done={done}
          tasks={tasks}
          tone={tone}
        />
      );
    }
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
        <p className={cn("text-ui-sm font-medium tabular-nums", tone.strong)}>
          Importing {done} of {run.total}…
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
            An import is already running on this device.
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
        className={cn(
          onboarding
            ? "onboarding-import-card"
            : "flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 py-10 text-center",
        )}
      >
        {onboarding ? (
          <span className="onboarding-import-glyph border-destructive/30 bg-destructive/10 text-destructive">
            <TriangleAlert aria-hidden className="size-5" />
          </span>
        ) : null}
        <p
          className={cn(
            onboarding
              ? "onboarding-import-headline"
              : "text-ui-sm font-medium",
            tone.strong,
          )}
        >
          {neverStarted
            ? "Import couldn’t start."
            : "Lost connection to the importing device."}
        </p>
        <p
          className={cn(
            "max-w-md text-ui-xs leading-relaxed text-pretty",
            tone.muted,
          )}
        >
          {neverStarted
            ? "Select your tasks again to retry."
            : "The import continues on that device."}
        </p>
        {onboarding ? (
          <SessionImportMoreButton hostId={hostId} label="Back to tasks" />
        ) : null}
      </div>
    );
  }

  return (
    <SessionImportSummary
      counts={counts}
      failures={failures}
      tone={tone}
      onboarding={onboarding}
      hostId={hostId}
    />
  );
}

/**
 * The onboarding card while the run is in flight: the ring, the counter, and
 * the submitted rows ticking off as the host reports on them.
 */
function SessionImportRunningCard(props: {
  readonly run: SessionImportRunState;
  readonly done: number;
  readonly tasks: ReadonlyArray<{
    readonly selectionKey: string;
    readonly title: string;
    readonly done: boolean;
  }>;
  readonly tone: SessionImportTone;
}) {
  const { run, done, tasks, tone } = props;
  return (
    <div
      role="status"
      data-testid="session-import-progress"
      className="onboarding-import-card"
    >
      <SessionImportRing done={done} total={run.total} />
      <p className={cn("onboarding-import-headline", tone.strong)}>
        {run.total === 0
          ? "Starting import…"
          : `Importing ${done} of ${run.total}`}
      </p>
      {run.lastTitle !== null ? (
        <p className={cn("max-w-full truncate text-ui-xs", tone.muted)}>
          {run.lastTitle}
        </p>
      ) : null}
      {tasks.length > 0 ? (
        <ul className="onboarding-import-progress-list">
          {tasks.map((task) => (
            <li
              key={task.selectionKey}
              data-done={task.done}
              className="onboarding-import-progress-task flex min-w-0 items-center gap-2"
            >
              <Check
                aria-hidden
                className="onboarding-import-check size-3.5 shrink-0 text-success-foreground"
              />
              <span className={cn("min-w-0 truncate", tone.muted)}>
                {task.title}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {run.attached ? (
        <p
          data-testid="session-import-progress-attached"
          className={cn("max-w-md text-ui-xs", tone.muted)}
        >
          An import is already running on this device.
        </p>
      ) : null}
    </div>
  );
}

/** What the run left behind: the counts, what did not land, and the way back. */
function SessionImportSummary(props: {
  readonly counts: SessionImportRunCounts;
  readonly failures: ReadonlyArray<SessionImportFailureGroupView>;
  readonly tone: SessionImportTone;
  readonly onboarding: boolean;
  readonly hostId: string | null;
}) {
  const { counts, failures, tone, onboarding, hostId } = props;
  const glyph =
    counts.imported > 0 ? (
      <span className="onboarding-import-glyph border-success/30 bg-success/10 text-success-foreground">
        <CircleCheck aria-hidden className="size-5" />
      </span>
    ) : (
      <span className="onboarding-import-glyph border-info/30 bg-info/10 text-info-foreground">
        <Info aria-hidden className="size-5" />
      </span>
    );
  return (
    <div
      data-testid="session-import-summary"
      className={cn(
        "flex min-h-0 flex-1 flex-col overflow-y-auto",
        !onboarding && "px-4 py-6",
      )}
    >
      {/* `m-auto` rather than `justify-center` on the scroller: a centered
          flex child that outgrows its box loses its top edge, while auto
          margins center what fits and scroll what does not. */}
      <div
        className={cn(
          onboarding
            ? "onboarding-import-card"
            : "m-auto flex w-full max-w-md flex-col items-center gap-4 text-center",
        )}
      >
        {onboarding ? glyph : null}
        <div className="flex flex-col gap-1">
          <p
            className={cn(
              onboarding
                ? "onboarding-import-headline tabular-nums"
                : "text-ui-sm font-medium tabular-nums",
              tone.strong,
            )}
          >
            {counts.imported === 0
              ? "Nothing was imported"
              : `Imported ${counts.imported} ${counts.imported === 1 ? "task" : "tasks"}`}
          </p>
          {counts.imported > 0 ? (
            <p className={cn("text-ui-xs", tone.muted)}>
              Ready in your task list.
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
        {onboarding ? (
          <SessionImportMoreButton hostId={hostId} label="Import more" />
        ) : null}
      </div>
    </div>
  );
}

/**
 * A ring rather than a spinner, because this run has a denominator: the arc IS
 * "how much of what I asked for is done". `stroke-dashoffset` is the only thing
 * that moves, so the browser animates one property on one element.
 */
function SessionImportRing(props: {
  readonly done: number;
  readonly total: number;
}) {
  const { done, total } = props;
  const circumference = 2 * Math.PI * 20;
  const fraction = total > 0 ? Math.min(done / total, 1) : 0;
  return (
    <svg
      aria-hidden
      viewBox="0 0 48 48"
      className="onboarding-import-ring size-12 shrink-0"
    >
      <circle className="onboarding-import-ring-track" cx="24" cy="24" r="20" />
      <circle
        className="onboarding-import-ring-value"
        cx="24"
        cy="24"
        r="20"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - fraction)}
      />
    </svg>
  );
}

/**
 * The way back to the list without leaving the wizard. The card holds until
 * this is pressed - it is what the user waited for, and a screen that rewrites
 * itself on a timer would pull it away mid-read. Retiring the run is all it
 * takes: the scan is paused only while a run is in flight and resumes on idle,
 * so the list comes back freshly read, with what just landed marked imported.
 */
function SessionImportMoreButton(props: {
  readonly hostId: string | null;
  readonly label: string;
}) {
  const { hostId, label } = props;
  if (hostId === null) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-testid="session-import-more"
      onClick={() => {
        useSessionImportRunStore.getState().reset(hostId);
      }}
    >
      {label}
    </Button>
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
