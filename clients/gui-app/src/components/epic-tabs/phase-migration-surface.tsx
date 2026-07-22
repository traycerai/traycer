import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { phaseMigrationController } from "./phase-migration-controller";

export interface PhaseMigrationSurfaceProps {
  readonly tabId: string;
  readonly phaseId: string;
}

/** Slot-local progress and recovery UI for one persisted Phase migration ref. */
export function PhaseMigrationSurface(
  props: PhaseMigrationSurfaceProps,
): ReactNode {
  const snapshot = useSyncExternalStore(
    phaseMigrationController.subscribe.bind(phaseMigrationController),
    () => phaseMigrationController.snapshot(props.tabId),
    () => null,
  );
  const [isTakingLonger, setIsTakingLonger] = useState(false);
  const isPending = snapshot === null || snapshot.status === "pending";
  const errorMessage =
    snapshot?.status === "error" ? snapshot.errorMessage : null;

  useEffect(() => {
    if (!isPending) return;
    const timer = window.setTimeout(() => setIsTakingLonger(true), 15_000);
    return () => window.clearTimeout(timer);
  }, [isPending]);

  return (
    <div
      data-testid="phase-to-epic-migration-screen"
      className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-background p-4"
    >
      <section className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-lg">
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-foreground">
            {errorMessage !== null ? (
              <span className="text-ui-sm font-semibold">!</span>
            ) : (
              <AgentSpinningDots
                className="text-foreground"
                testId="phase-to-epic-migration-spinner"
                variant="dots"
              />
            )}
          </div>
          <div className="min-w-0 space-y-2">
            <h2 className="text-ui-sm font-semibold text-foreground">
              Migrating Phase to Epic
            </h2>
            <p className="text-ui-sm leading-6 text-muted-foreground">
              Converting this legacy Phase into an Epic. Phase tasks are being
              turned into tickets, and saved plans or verification notes are
              being attached as spec and review artifacts.
            </p>
            {isPending && isTakingLonger ? (
              <p className="text-ui-sm leading-6 text-muted-foreground">
                Still migrating. Larger Phases can take a little longer while
                the desktop host copies the room and uploads the Epic.
              </p>
            ) : null}
            {errorMessage !== null ? (
              <p
                className="text-ui-sm leading-6 text-destructive"
                data-testid="phase-to-epic-migration-error"
              >
                {errorMessage}
              </p>
            ) : null}
            {errorMessage !== null ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => phaseMigrationController.retry(props.tabId)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Re-attempt migration
                </Button>
                <ReportIssueAction
                  context={createReportIssueContext({
                    title: "Phase migration did not finish",
                    message: "The legacy Phase migration did not complete.",
                    code: null,
                    source: "Phase migration",
                  })}
                  presentation="text"
                  className={undefined}
                />
              </div>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
