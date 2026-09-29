import { useMemo, type ReactNode } from "react";
import {
  Dialog,
  DialogPopup,
  DialogBackdrop,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { createReportIssueContext } from "@/lib/report-issue-context";
import {
  epicsSeen,
  migrationModalRun,
  MIGRATION_RUN_IDLE,
  taskChainsSeen,
  useMigrationRunStore,
  type MigrationRunState,
} from "@/stores/migration/migration-run-store";

const MIGRATION_PROGRESS_LABEL = "Migrating tasks";

/**
 * ONE modal for the whole app, whichever machine raised it: it blocks the app
 * while a migration runs, so a second host migrating at the same time is not a
 * second modal. `migrationModalRun` picks whose progress it shows - a live
 * migration first, then a failure nobody has acknowledged.
 */
export function MigrationBlockingModalHost(): ReactNode {
  const runs = useMigrationRunStore((s) => s.runs);
  const remoteRunning = useMigrationRunStore((s) => s.remoteRunning);
  const reset = useMigrationRunStore((s) => s.reset);
  const entry = useMemo(() => migrationModalRun(runs), [runs]);

  const status = entry?.run.status ?? "idle";
  const isErrorAck = status === "error";
  const isRunning = status === "running" || remoteRunning;
  const open = isRunning || isErrorAck;

  if (!open) {
    return null;
  }

  return (
    <Dialog
      paneAware={false}
      open
      modal
      onOpenChange={(_open, details) => details.cancel()}
    >
      <DialogPortal>
        <DialogBackdrop
          data-slot="dialog-overlay"
          data-testid="migration-blocking-overlay"
          variant="blocking"
        />
        <DialogPopup
          data-slot="dialog-content"
          data-testid="migration-blocking-modal"
          aria-describedby={undefined}
          // Safe centre on both axes, not the viewport's halfway marks: this
          // frame is portalled and `fixed`, so it centres over the status-bar
          // strip and the landscape sensor housing too unless it is told where
          // the app's part of the screen is.
          variant="blocking"
          className="w-[min(90vw,28rem,var(--safe-area-width))]"
        >
          {isRunning ? (
            <RunningBody
              status={status}
              totals={entry?.run.totals ?? null}
              counts={entry?.run.counts ?? MIGRATION_RUN_IDLE.counts}
              isRemote={status !== "running" && remoteRunning}
            />
          ) : (
            <ErrorBody
              finalSuccess={entry?.run.finalSuccess ?? null}
              // Acknowledges the failure this modal is showing, and only it:
              // another host's run is not this button's to retire.
              onAcknowledge={() => {
                if (entry !== null) reset(entry.hostId);
              }}
            />
          )}
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}

interface RunningBodyProps {
  readonly status: MigrationRunState["status"];
  readonly totals: MigrationRunState["totals"];
  readonly counts: MigrationRunState["counts"];
  readonly isRemote: boolean;
}

function RunningBody(props: RunningBodyProps): ReactNode {
  const { status, totals, counts, isRemote } = props;
  return (
    <>
      <DialogTitle data-slot="dialog-title" appearance="host" size="blocking">
        {MIGRATION_PROGRESS_LABEL}
      </DialogTitle>
      <p className="text-sm text-muted-foreground">
        {isRemote
          ? "A migration is running in another window. Please wait - it will finish shortly."
          : "Moving your local tasks and epics to the cloud. Please don't close the app."}
      </p>
      <div className="flex items-center gap-3 rounded-md border border-border/60 bg-muted/40 px-3 py-2">
        <AgentSpinningDots
          className={undefined}
          testId="migration-blocking-spinner"
          variant={undefined}
        />
        <span className="text-sm font-mono">
          {progressLabel(status, totals, counts)}
        </span>
      </div>
    </>
  );
}

interface ErrorBodyProps {
  readonly finalSuccess: boolean | null;
  readonly onAcknowledge: () => void;
}

function ErrorBody(props: ErrorBodyProps): ReactNode {
  const { finalSuccess, onAcknowledge } = props;
  const message =
    finalSuccess === false
      ? "Migration finished with some incomplete items. You can re-attempt later from Settings."
      : "Migration connection was interrupted. The host-side state is preserved - re-open settings to retry.";
  return (
    <>
      <DialogTitle data-slot="dialog-title" appearance="host" size="blocking">
        Migration interrupted
      </DialogTitle>
      <p className="text-sm text-muted-foreground">{message}</p>
      <div className="flex flex-wrap justify-end gap-2">
        <ReportIssueAction
          context={createReportIssueContext({
            title: "Migration interrupted",
            message: "The migration did not finish.",
            code: null,
            source: "Data migration",
          })}
          presentation="text"
          className={undefined}
        />
        <Button type="button" onClick={onAcknowledge}>
          Dismiss
        </Button>
      </div>
    </>
  );
}

function progressLabel(
  status: MigrationRunState["status"],
  totals: MigrationRunState["totals"],
  counts: MigrationRunState["counts"],
): string {
  if (status !== "running") {
    return "Waiting for live progress…";
  }
  if (totals === null) {
    return "Counting items…";
  }
  return `tasks ${taskChainsSeen(counts)}/${totals.totalTaskChains}, epics ${epicsSeen(counts)}/${totals.totalLocalEpics}`;
}
