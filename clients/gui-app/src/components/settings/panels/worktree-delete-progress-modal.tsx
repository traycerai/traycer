import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronUp, X } from "lucide-react";
import type { WorktreeDeletePhase } from "@traycer/protocol/host/worktree-delete-stream";
import type { WorktreeHostEntry } from "@traycer/protocol/host/index";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { cn } from "@/lib/utils";
import type {
  LogSegment,
  WorktreeDeleteRunState,
} from "@/components/settings/panels/use-worktree-delete-run";

interface StepDefinition {
  readonly key: WorktreeDeletePhase;
  readonly label: string;
}

type StepState = "done" | "active" | "pending" | "error";

export interface WorktreeDeleteProgressModalProps {
  readonly target: WorktreeHostEntry;
  readonly run: WorktreeDeleteRunState;
  readonly onClose: () => void;
}

/**
 * Progress card for a worktree delete, shown inside the viewport-anchored
 * Worktrees delete overlay. It shows a phased step indicator (teardown →
 * remove) and, when a teardown script runs, a collapsible pane streaming its
 * stdout/stderr. While the delete is running the action reads
 * "Run in background", which dismisses the modal and lets the worktree's row
 * carry the in-progress state; once terminal it offers an explicit Close.
 */
export function WorktreeDeleteProgressModal(
  props: WorktreeDeleteProgressModalProps,
): ReactNode {
  const { target, run, onClose } = props;
  const inProgress = run.status === "queued" || run.status === "running";
  const branch = target.branch ?? "detached HEAD";
  const errorMessage = errorMessageFor(run);

  const steps: StepDefinition[] = run.hasTeardown
    ? [
        { key: "teardown", label: "Run teardown script" },
        { key: "remove", label: "Remove worktree" },
      ]
    : [{ key: "remove", label: "Remove worktree" }];

  return (
    <output
      data-slot="worktree-delete-progress"
      data-testid="worktree-delete-progress-modal"
      className="flex w-full flex-col gap-4 px-5 py-4 text-foreground"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="font-heading text-ui-sm leading-none font-medium">
            {titleFor(run)}
          </p>
          <p className="text-ui-xs wrap-anywhere text-muted-foreground">
            {subtitleFor(run, branch)}
          </p>
        </div>
        <Button
          type="button"
          variant={inProgress ? "ghost" : "default"}
          size="sm"
          onClick={onClose}
          data-testid="worktree-delete-close-button"
          className="shrink-0"
        >
          {inProgress ? "Run in background" : "Close"}
        </Button>
      </div>

      <ol className="flex flex-col gap-2 rounded-md border border-border/60 bg-background/60 p-3">
        {steps.map((step) => (
          <StepRow
            key={step.key}
            step={step}
            state={resolveStepState(step.key, run, steps)}
            log={step.key === "teardown" ? run.log : null}
          />
        ))}
      </ol>

      {errorMessage !== null ? (
        <div
          data-testid="worktree-delete-error"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui-sm wrap-anywhere text-destructive"
        >
          <span className="min-w-0 flex-1">{errorMessage}</span>
          <ReportIssueAction
            context={createReportIssueContext({
              title: "Could not delete worktree",
              message: null,
              code: null,
              source: "Worktrees",
            })}
            presentation="icon"
            className="-my-1 shrink-0 text-current"
          />
        </div>
      ) : null}
    </output>
  );
}

function StepRow(props: {
  readonly step: StepDefinition;
  readonly state: StepState;
  readonly log: readonly LogSegment[] | null;
}): ReactNode {
  const { step, state, log } = props;
  return (
    <li className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <StepIcon state={state} />
        <span
          className={cn(
            "text-sm",
            state === "pending" ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {step.label}
        </span>
      </div>
      {log !== null ? (
        <div className="pl-8">
          <TeardownLog log={log} active={state === "active"} />
        </div>
      ) : null}
    </li>
  );
}

function StepIcon(props: { readonly state: StepState }): ReactNode {
  if (props.state === "done") {
    return (
      <span
        aria-hidden
        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary"
      >
        <Check className="size-3" />
      </span>
    );
  }
  if (props.state === "error") {
    return (
      <span
        aria-hidden
        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-destructive"
      >
        <X className="size-3" />
      </span>
    );
  }
  if (props.state === "active") {
    return (
      <span
        aria-hidden
        className="flex size-5 shrink-0 items-center justify-center"
      >
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="size-5 shrink-0 rounded-full border border-border/80 bg-transparent"
    />
  );
}

/**
 * Collapsible toggle around the teardown script's streamed output - the same
 * `tail -f`-style treatment as the host bootstrap-log view. Collapsed by
 * default; the user expands to watch.
 */
function TeardownLog(props: {
  readonly log: readonly LogSegment[];
  readonly active: boolean;
}): ReactNode {
  const [open, setOpen] = useState<boolean>(false);
  const Icon = open ? ChevronUp : ChevronDown;
  return (
    <div className="flex flex-col items-stretch gap-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="worktree-delete-log-toggle"
        className="inline-flex items-center gap-1 self-start text-ui-xs text-muted-foreground hover:text-foreground"
      >
        <span>{open ? "Hide output" : "Show output"}</span>
        <Icon className="size-3" />
      </button>
      {open ? <TeardownLogBody log={props.log} active={props.active} /> : null}
    </div>
  );
}

function TeardownLogBody(props: {
  readonly log: readonly LogSegment[];
  readonly active: boolean;
}): ReactNode {
  const ref = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
  }, [props.log]);

  if (props.log.length === 0) {
    return (
      <p className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-ui-xs text-muted-foreground">
        {props.active ? "Waiting for teardown output…" : "No output."}
      </p>
    );
  }
  return (
    <pre
      ref={ref}
      data-testid="worktree-delete-log"
      className="max-h-48 w-full overflow-auto rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-left font-mono text-code-xs whitespace-pre-wrap text-muted-foreground"
    >
      {props.log.map((segment) => (
        <span
          key={segment.id}
          className={cn(
            segment.channel === "stderr" ? "text-destructive/80" : null,
          )}
        >
          {segment.text}
        </span>
      ))}
    </pre>
  );
}

function resolveStepState(
  key: WorktreeDeletePhase,
  run: WorktreeDeleteRunState,
  steps: readonly StepDefinition[],
): StepState {
  if (run.status === "complete" && run.deleted) {
    return "done";
  }
  const order = steps.map((step) => step.key);
  const idx = order.indexOf(key);
  const activeIdx =
    run.activePhase === null ? -1 : order.indexOf(run.activePhase);

  if (run.status === "failed" || run.status === "complete") {
    // Terminal failure: mark the step that was in flight (if any) as the
    // error, steps before it done, steps after it pending.
    if (activeIdx === -1) return "pending";
    if (idx < activeIdx) return "done";
    if (idx === activeIdx) return "error";
    return "pending";
  }

  // Running.
  if (activeIdx === -1) return "pending";
  if (idx < activeIdx) return "done";
  if (idx === activeIdx) return "active";
  return "pending";
}

function titleFor(run: WorktreeDeleteRunState): string {
  if (run.status === "complete") {
    return run.deleted ? "Worktree deleted" : "Couldn't delete worktree";
  }
  if (run.status === "failed") {
    return "Couldn't delete worktree";
  }
  if (run.status === "queued") {
    return "Delete queued";
  }
  return "Deleting worktree";
}

function subtitleFor(run: WorktreeDeleteRunState, branch: string): string {
  if (run.status === "complete" && run.deleted) {
    return `${branch} was removed.`;
  }
  if (run.status === "running") {
    return `Removing ${branch}. Run it in the background to keep working.`;
  }
  if (run.status === "queued") {
    return `${branch} will start when earlier deletes finish.`;
  }
  return branch;
}

function errorMessageFor(run: WorktreeDeleteRunState): string | null {
  if (run.status === "failed") {
    return run.error;
  }
  if (run.status === "complete" && !run.deleted) {
    return "Couldn't remove the worktree. It may still be in use - refresh and try again.";
  }
  return null;
}
