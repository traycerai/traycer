import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronDown, ChevronRight } from "lucide-react";
import type {
  WorktreeAutoCleanupRunSummary,
  WorktreeAutoCleanupTarget,
} from "@traycer/protocol/host/worktree-auto-cleanup-schemas";
import { WORKTREE_TIER_LABEL } from "@traycer-clients/shared/worktree/classify-worktree";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import {
  useWorktreeAutoCleanupRun,
  useWorktreeAutoCleanupRuns,
} from "@/hooks/worktree/use-worktree-auto-cleanup";
import {
  AUTO_CLEANUP_OUTCOME_LABEL,
  autoCleanupOutcomeTone,
  autoCleanupRunSummaryLine,
  autoCleanupTargetMessage,
} from "@/components/settings/panels/worktree-auto-cleanup-copy";
import { useWorktreeCleanupViewStore } from "@/stores/settings/worktree-cleanup-view-store";
import { useRelativeTimestamp } from "@/lib/relative-time";

/**
 * Settings ▸ Worktrees ▸ Cleanup history — what unattended cleanup actually
 * did on this host, newest run first.
 *
 * The presentational rule this screen exists to keep (see
 * `worktree-auto-cleanup-copy.ts`): a `skipped` target is the safety engine
 * working and an `interrupted` one is honestly unconfirmed. Only `failed`
 * wears failure styling. Each target row stands on its own — a later
 * re-selection of the same path is an ordinary new row, never folded into the
 * attempt before it.
 *
 * `worktreePath` renders verbatim. It names a directory on the very host the
 * panel is already talking to, which is exactly why history never leaves it.
 */
export function WorktreeCleanupHistory(props: {
  readonly scope: HostScope;
  readonly onBack: () => void;
}): ReactNode {
  const { scope, onBack } = props;
  const client = scope.client;
  const focusedRunId = useWorktreeCleanupViewStore(
    (state) => state.focusedRunId,
  );
  const clearFocusedRun = useWorktreeCleanupViewStore(
    (state) => state.clearFocusedRun,
  );
  // The arriving hint is the DEFAULT expansion, not seeded state: a `useState`
  // initializer would miss a hint that lands while this view is already
  // mounted (a second notification), and syncing it back in an effect is a
  // cascading render. `manualExpansion` is the user's own later choice, and
  // `null` means they have not made one yet.
  const [manualExpansion, setManualExpansion] = useState<{
    readonly runId: string | null;
  } | null>(null);
  const expandedRunId =
    manualExpansion === null ? focusedRunId : manualExpansion.runId;
  // The hint is consumed when this view goes away. Left set, it would silently
  // re-expand a run the user had closed the next time history mounts.
  useEffect(() => clearFocusedRun, [clearFocusedRun]);
  const runs = useWorktreeAutoCleanupRuns(client, client !== null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border/40 px-5 py-2.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onBack}
          aria-label="Back to worktrees"
        >
          <ArrowLeft className="size-4" />
          <span>Worktrees</span>
        </Button>
        <span className="min-w-0 truncate text-ui-sm font-medium text-foreground">
          Automatic cleanup history
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <WorktreeCleanupHistoryBody
          client={client}
          runs={runs}
          expandedRunId={expandedRunId}
          onToggleRun={(runId) => {
            setManualExpansion({
              runId: expandedRunId === runId ? null : runId,
            });
          }}
        />
      </div>
    </div>
  );
}

interface CleanupRunsView {
  readonly runs: readonly WorktreeAutoCleanupRunSummary[];
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly errorMessage: string | null;
  readonly hasMore: boolean;
  readonly isLoadingMore: boolean;
  readonly loadMore: () => void;
}

function WorktreeCleanupHistoryBody(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly runs: CleanupRunsView;
  readonly expandedRunId: string | null;
  readonly onToggleRun: (runId: string) => void;
}): ReactNode {
  const { client, runs, expandedRunId, onToggleRun } = props;
  if (runs.isPending) {
    return (
      <CleanupHistoryMessage tone="muted">
        Loading cleanup history…
      </CleanupHistoryMessage>
    );
  }
  if (runs.isError) {
    return (
      <CleanupHistoryMessage tone="error">
        {runs.errorMessage ?? "Couldn't load cleanup history."}
      </CleanupHistoryMessage>
    );
  }
  if (runs.runs.length === 0) {
    return (
      <CleanupHistoryMessage tone="muted">
        No automatic cleanup has run on this host yet.
      </CleanupHistoryMessage>
    );
  }
  return (
    <div data-testid="worktree-cleanup-history-runs">
      {runs.runs.map((run) => (
        <CleanupRunRow
          key={run.runId}
          client={client}
          run={run}
          expanded={run.runId === expandedRunId}
          onToggle={() => onToggleRun(run.runId)}
        />
      ))}
      {runs.hasMore ? (
        <div className="flex justify-center px-5 py-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={runs.isLoadingMore}
            onClick={runs.loadMore}
          >
            {runs.isLoadingMore ? (
              <AgentSpinningDots
                className="text-muted-foreground"
                testId="worktree-cleanup-history-loading-more"
                variant={undefined}
              />
            ) : null}
            <span>Load more</span>
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function CleanupHistoryMessage(props: {
  readonly tone: "muted" | "error";
  readonly children: ReactNode;
}): ReactNode {
  return (
    <p
      className={cn(
        "px-5 py-6 text-ui-sm",
        props.tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
      role={props.tone === "error" ? "alert" : undefined}
    >
      {props.children}
    </p>
  );
}

function CleanupRunRow(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly run: WorktreeAutoCleanupRunSummary;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}): ReactNode {
  const { client, run, expanded, onToggle } = props;
  const started = useRelativeTimestamp(run.startedAt);
  return (
    <div
      className="border-b border-border/40 last:border-b-0"
      data-testid="worktree-cleanup-run"
      data-run-id={run.runId}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-start gap-2 px-5 py-3 text-left hover:bg-foreground/5"
      >
        {expanded ? (
          <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-ui-sm font-medium text-foreground">
              {started}
            </span>
            {/* `running` is the only non-terminal status. `interrupted` is
                terminal for the RUN record, so it must never read as
                "still working". */}
            {run.status === "running" ? (
              <span className="text-ui-xs text-muted-foreground">Running…</span>
            ) : null}
            {run.status === "interrupted" ? (
              <span className="text-ui-xs text-muted-foreground">
                Unconfirmed — Host stopped during cleanup
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 block text-ui-xs text-muted-foreground">
            <span data-testid="worktree-cleanup-run-counts">
              {autoCleanupRunSummaryLine(run)}
            </span>
            {" · "}
            <span>{run.inactivityDays} day threshold</span>
            {run.budgetExhausted ? <span> · more to do next pass</span> : null}
          </span>
        </span>
      </button>
      {expanded ? (
        <CleanupRunTargets client={client} runId={run.runId} />
      ) : null}
    </div>
  );
}

function CleanupRunTargets(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly runId: string;
}): ReactNode {
  const { client, runId } = props;
  const query = useWorktreeAutoCleanupRun(client, runId, client !== null);
  const error = query.error;
  if (error !== null) {
    return (
      <p role="alert" className="px-5 pb-3 pl-11 text-ui-xs text-destructive">
        {error.message}
      </p>
    );
  }
  const data = query.data;
  if (data === undefined) {
    return (
      <p className="px-5 pb-3 pl-11 text-ui-xs text-muted-foreground">
        Loading this run…
      </p>
    );
  }
  // `run: null` is an ordinary outcome, not an error: retention GC bounds
  // history, so a notification can outlive the run it names.
  if (data.run === null) {
    return (
      <p className="px-5 pb-3 pl-11 text-ui-xs text-muted-foreground">
        This run is no longer in this host&apos;s history.
      </p>
    );
  }
  if (data.targets.length === 0) {
    return (
      <p className="px-5 pb-3 pl-11 text-ui-xs text-muted-foreground">
        No worktrees were selected in this run.
      </p>
    );
  }
  return (
    <ul className="pb-2 pl-11" data-testid="worktree-cleanup-targets">
      {data.targets.map((target) => (
        <CleanupTargetRow key={target.targetId} target={target} />
      ))}
    </ul>
  );
}

function CleanupTargetRow(props: {
  readonly target: WorktreeAutoCleanupTarget;
}): ReactNode {
  const { target } = props;
  const tone = autoCleanupOutcomeTone(target.outcome);
  const message = autoCleanupTargetMessage(target);
  return (
    <li
      className="border-t border-border/30 py-2 pr-5 first:border-t-0"
      data-testid="worktree-cleanup-target"
      data-outcome={target.outcome ?? "queued"}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span
          className={cn(
            "text-ui-xs font-medium",
            tone === "failure" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {target.outcome === null
            ? "Queued"
            : AUTO_CLEANUP_OUTCOME_LABEL[target.outcome]}
        </span>
        <span className="text-ui-sm text-foreground">{target.repoLabel}</span>
        {target.branchLabel === null ? null : (
          <span className="font-mono text-ui-xs text-muted-foreground">
            {target.branchLabel}
          </span>
        )}
        <span className="text-ui-xs text-muted-foreground">
          {WORKTREE_TIER_LABEL[target.tierAtSelection]}
        </span>
      </div>
      <StartTruncatedText className="mt-0.5 block font-mono text-ui-xs text-muted-foreground">
        {target.worktreePath}
      </StartTruncatedText>
      {message === null ? null : (
        <p className="mt-0.5 text-ui-xs text-muted-foreground">{message}</p>
      )}
      {target.teardownTimedOut ||
      (target.teardownExitCode !== null && target.teardownExitCode !== 0) ? (
        <p className="mt-0.5 text-ui-xs text-muted-foreground">
          {target.teardownTimedOut
            ? "Teardown timed out."
            : `Teardown exited ${String(target.teardownExitCode)}.`}
        </p>
      ) : null}
    </li>
  );
}
