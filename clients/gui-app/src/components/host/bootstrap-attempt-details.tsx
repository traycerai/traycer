import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  describeOutcome,
  type BootstrapAttemptSummary,
} from "@/components/host/bootstrap-attempt-summary";

export interface BootstrapAttemptDetailsProps {
  readonly summary: BootstrapAttemptSummary;
  readonly bootstrapLogPath: string | null;
}

/**
 * What was tried and what happened: the shell and args of the last attempt,
 * its terminal outcome, and where the full log lives - so a stuck startup
 * reads as "we ran `zsh -i -l -c …` and it crashed with code 1, full log at
 * …" rather than a blank wait.
 *
 * Lives here rather than beside its original consumer because that consumer
 * (`LocalHostUnavailable`) is no longer rendered in production, and importing
 * a live surface out of a file queued for deletion would re-anchor it.
 *
 * Deliberately NOT behind the "Show details" disclosure. The log PATH is the
 * one thing a user needs in order to take the problem somewhere else, and a
 * path they have to discover by expanding a toggle is a path most never find.
 */
export function BootstrapAttemptDetails(
  props: BootstrapAttemptDetailsProps,
): ReactNode {
  const { attempt, outcome } = props.summary;
  const shell = attempt.fields.shell ?? null;
  const argsField = attempt.fields.args ?? null;
  const outcomeText = outcome !== null ? describeOutcome(outcome) : null;

  return (
    <div
      data-testid="local-host-bootstrap-details"
      className="flex w-full flex-col gap-2 rounded-md border border-border bg-muted/40 p-3 text-left text-ui-xs text-muted-foreground"
    >
      {shell !== null ? (
        <div className="flex flex-col">
          <span className="text-foreground/70">Last attempt</span>
          <code className="break-all font-mono text-ui-xs">
            {shell}
            {argsField !== null ? ` ${argsField}` : ""}
          </code>
        </div>
      ) : null}
      {outcomeText !== null ? (
        <div
          className={cn(
            "flex flex-col",
            outcome?.phase === "failed-to-spawn" || outcome?.phase === "crashed"
              ? "text-destructive"
              : null,
          )}
        >
          <span>{outcomeText}</span>
          {outcome?.fields.error !== undefined &&
          outcome.phase !== "failed-to-spawn" ? (
            <code className="mt-1 break-all font-mono text-ui-xs">
              {outcome.fields.error}
            </code>
          ) : null}
        </div>
      ) : (
        <span>Host never reported a terminal status.</span>
      )}
      {props.bootstrapLogPath !== null ? (
        <div className="flex flex-col">
          <span className="text-foreground/70">Full log</span>
          <code
            data-testid="local-host-bootstrap-log-path"
            className="break-all font-mono text-ui-xs"
          >
            {props.bootstrapLogPath}
          </code>
        </div>
      ) : null}
    </div>
  );
}
