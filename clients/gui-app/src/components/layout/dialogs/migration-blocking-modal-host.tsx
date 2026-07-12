import { type ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { createReportIssueContext } from "@/lib/report-issue-context";
import {
  epicsSeen,
  taskChainsSeen,
  useMigrationRunStore,
  type MigrationRunState,
} from "@/stores/migration/migration-run-store";

const MIGRATION_PROGRESS_LABEL = "Migrating tasks";

export function MigrationBlockingModalHost(): ReactNode {
  const status = useMigrationRunStore((s) => s.status);
  const totals = useMigrationRunStore((s) => s.totals);
  const counts = useMigrationRunStore((s) => s.counts);
  const finalSuccess = useMigrationRunStore((s) => s.finalSuccess);
  const remoteRunning = useMigrationRunStore((s) => s.remoteRunning);
  const reset = useMigrationRunStore((s) => s.reset);

  const isErrorAck = status === "error";
  const isRunning = status === "running" || remoteRunning;
  const open = isRunning || isErrorAck;

  if (!open) {
    return null;
  }

  return (
    <DialogPrimitive.Root open modal>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-slot="dialog-overlay"
          data-testid="migration-blocking-overlay"
          className="fixed inset-0 isolate z-[60] bg-black/40 duration-100 supports-backdrop-filter:backdrop-blur-sm data-open:animate-in data-open:fade-in-0"
        />
        <DialogPrimitive.Content
          data-slot="dialog-content"
          data-testid="migration-blocking-modal"
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => {
            if (isRunning) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (isRunning) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (isRunning) event.preventDefault();
          }}
          className="fixed top-1/2 left-1/2 z-[60] flex w-[min(90vw,28rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl bg-background p-6 text-foreground ring-1 ring-foreground/10 shadow-2xl outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95"
        >
          {isRunning ? (
            <RunningBody
              status={status}
              totals={totals}
              counts={counts}
              isRemote={status !== "running" && remoteRunning}
            />
          ) : (
            <ErrorBody
              finalSuccess={finalSuccess}
              onAcknowledge={() => reset()}
            />
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
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
      <DialogPrimitive.Title
        data-slot="dialog-title"
        className="font-heading text-lg leading-none font-medium"
      >
        {MIGRATION_PROGRESS_LABEL}
      </DialogPrimitive.Title>
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
      <DialogPrimitive.Title
        data-slot="dialog-title"
        className="font-heading text-lg leading-none font-medium"
      >
        Migration interrupted
      </DialogPrimitive.Title>
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
