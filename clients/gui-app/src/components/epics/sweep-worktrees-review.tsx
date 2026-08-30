import { useId, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  formatStopHeading,
  formatTeardownActors,
  formatUnknownHolderConsequence,
} from "@/lib/worktree/teardown-holder-copy";
import {
  bindingHeading,
  distinctExternalEpicIds,
  finalSweepButtonLabel,
  removalSummaryCopy,
  unprovenRowHint,
  worktreeIdentity,
  type SweepReviewSnapshot,
} from "@/lib/epics/sweep-consequences";
import { cn } from "@/lib/utils";

export function SweepWorktreesReview(props: {
  readonly snapshot: SweepReviewSnapshot;
  readonly selectedEpicIds: ReadonlySet<string>;
  readonly agentNames: ReadonlyMap<string, string>;
  readonly taskTitles: ReadonlyMap<string, string>;
  readonly typedValue: string;
  readonly inventoryChanged: boolean;
  readonly activeSweepCount: number;
  readonly onTypedValueChange: (value: string) => void;
  readonly onBack: () => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): ReactNode {
  const needsTypedGate = props.snapshot.unproven.length > 0;
  const typedOk = !needsTypedGate || props.typedValue === "sweep";
  const typedConfirmId = useId();
  const stopActors = formatTeardownActors(
    props.snapshot.disclosedHolders,
    props.agentNames,
  );
  const unknownRows = props.snapshot.inUse.filter(
    (row) => row.holders.length === 0,
  ).length;
  const externalEpicIds = distinctExternalEpicIds(
    props.snapshot.shared,
    props.selectedEpicIds,
  );
  const removal = removalSummaryCopy(
    props.snapshot.all.length,
    props.snapshot.branchNames.length,
  );
  const confirmLabel = finalSweepButtonLabel(props.snapshot.all);

  return (
    <>
      <div className="flex min-w-0 shrink-0 items-start gap-3 px-5 pt-5 pb-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <AlertTriangle className="size-4" aria-hidden />
        </div>
        <div className="min-h-0 min-w-0 flex-1 space-y-1.5">
          <DialogTitle className="text-ui font-semibold leading-snug wrap-anywhere">
            Review this sweep
          </DialogTitle>
          <DialogDescription className="text-ui-sm leading-relaxed text-muted-foreground wrap-anywhere">
            Only the consequences of your current selection are shown.
          </DialogDescription>
        </div>
      </div>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-2.5 overflow-y-auto border-t border-border/60 bg-foreground/2 px-5 py-4">
        {props.inventoryChanged ? (
          <p
            className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-ui-sm text-foreground"
            data-testid="sweep-inventory-changed"
          >
            What is running changed. Review the updated consequences before
            continuing.
          </p>
        ) : null}
        {props.snapshot.pendingUncertain.length > 0 ? (
          <p
            className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-ui-sm text-foreground"
            data-testid="sweep-review-uncertain"
          >
            {props.snapshot.pendingUncertain.join(", ")} unconfirmed — check the
            worktree. That deletion is not being retried.
          </p>
        ) : null}
        {props.snapshot.retryableFailed.length > 0 ? (
          <p
            className="rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-ui-sm text-foreground"
            data-testid="sweep-review-failed"
          >
            {props.snapshot.retryableFailed.join(", ")}{" "}
            {`couldn't be removed — go back and select again to retry.`}
          </p>
        ) : null}
        {props.snapshot.unproven.length > 0 ? (
          <ReviewSection
            title="Work may be permanently lost"
            danger
            testId="sweep-review-loss"
          >
            {props.snapshot.unproven.map((row) => (
              <div key={row.entry.worktreePath} className="space-y-1">
                <p className="text-ui-xs font-medium">
                  {worktreeIdentity(row)}
                </p>
                <p className="text-ui-xs text-amber-700 dark:text-amber-400">
                  {unprovenRowHint(row)}
                </p>
              </div>
            ))}
          </ReviewSection>
        ) : null}
        {props.snapshot.inUse.length > 0 ? (
          <ReviewSection
            title={formatStopHeading({
              knownActors: stopActors.length,
              unknownRows,
            })}
            danger={false}
            testId="sweep-review-stops"
          >
            {props.snapshot.inUse.map((row) => (
              <div key={row.entry.worktreePath} className="space-y-1">
                <p className="text-ui-xs font-medium">
                  {worktreeIdentity(row)}
                </p>
                {row.holders.length === 0 ? (
                  <p className="text-ui-xs wrap-anywhere text-foreground">
                    {formatUnknownHolderConsequence(worktreeIdentity(row))}
                  </p>
                ) : (
                  formatTeardownActors(row.holders, props.agentNames).map(
                    (actor) => (
                      <div key={actor.key} className="space-y-0.5">
                        <p className="text-ui-xs wrap-anywhere text-foreground">
                          {actor.sentence}
                        </p>
                        {actor.evidence.map((line) => (
                          <p
                            key={line}
                            className="text-ui-xs wrap-anywhere text-muted-foreground"
                          >
                            {line}
                          </p>
                        ))}
                      </div>
                    ),
                  )
                )}
              </div>
            ))}
          </ReviewSection>
        ) : null}
        {props.snapshot.shared.length > 0 ? (
          <ReviewSection
            title={bindingHeading(Math.max(externalEpicIds.length, 1))}
            danger={false}
            testId="sweep-review-shared"
          >
            {props.snapshot.shared.map((row) => (
              <div key={row.entry.worktreePath} className="space-y-0.5">
                <p className="text-ui-xs wrap-anywhere">
                  {worktreeIdentity(row)}
                </p>
                {distinctExternalEpicIds([row], props.selectedEpicIds).map(
                  (epicId) => (
                    <p
                      key={epicId}
                      className="text-ui-xs wrap-anywhere text-muted-foreground"
                    >
                      {props.taskTitles.get(epicId) ?? epicId}
                    </p>
                  ),
                )}
              </div>
            ))}
          </ReviewSection>
        ) : null}
        <div
          className="rounded-lg border border-border/60 bg-background/60 px-3 py-2.5"
          data-testid="sweep-review-removal"
        >
          <p className="text-ui-sm font-medium">{removal.worktrees}</p>
          <p className="text-ui-xs text-muted-foreground">{removal.branches}</p>
        </div>
        {needsTypedGate ? (
          <div className="space-y-1.5">
            <label htmlFor={typedConfirmId} className="text-ui-xs font-medium">
              Type <code className="font-mono">sweep</code> to confirm possible
              loss of unmerged work
            </label>
            <Input
              id={typedConfirmId}
              value={props.typedValue}
              onChange={(event) =>
                props.onTypedValueChange(event.currentTarget.value)
              }
              placeholder="sweep"
              autoComplete="off"
              spellCheck={false}
              data-testid="sweep-typed-confirm"
            />
          </div>
        ) : null}
      </section>
      <div className="flex min-w-0 shrink-0 items-center justify-between gap-2 border-t border-border/60 bg-foreground/3 px-5 py-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={props.onBack}
          data-testid="sweep-worktrees-back"
        >
          Back
        </Button>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={props.onCancel}
            data-testid="sweep-worktrees-cancel"
          >
            {props.activeSweepCount > 0 ? "Close" : "Cancel"}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={!typedOk}
            onClick={props.onConfirm}
            data-testid="sweep-worktrees-confirm"
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </>
  );
}

function ReviewSection(props: {
  readonly title: string;
  readonly danger: boolean;
  readonly testId: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <article
      className={cn(
        "overflow-hidden rounded-lg border bg-background/60",
        props.danger ? "border-destructive/40" : "border-border/60",
      )}
      data-testid={props.testId}
    >
      <h3
        className={cn(
          "px-3 py-2 text-ui-sm font-medium",
          props.danger
            ? "bg-destructive/8 text-destructive"
            : "bg-foreground/4 text-foreground",
        )}
      >
        {props.title}
      </h3>
      <div className="space-y-2 px-3 py-2">{props.children}</div>
    </article>
  );
}
