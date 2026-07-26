import { use, useCallback, type MouseEvent, type ReactNode } from "react";
import {
  ExternalLink,
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  GitPullRequestDraft,
  RotateCcw,
  type LucideIcon,
} from "lucide-react";
import type { PrDetailCore, PrState } from "@traycer/protocol/host/pr-schemas";
import { Button } from "@/components/ui/button";
import {
  PR_DIFF_ADDED_CLASS,
  PR_DIFF_REMOVED_CLASS,
} from "@/components/epic-canvas/pr/pr-detail-tone";
import { useRunnerOpenExternalLink } from "@/hooks/runner/use-open-external-link-mutation";
import { formatPrActorName } from "@/lib/pr/pr-detail-projection";
import { useRelativeTimestamp } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { RunnerHostContext } from "@/providers/runner-host-context";

type PrDisplayState = PrState | "draft";

/**
 * State pills in theme tokens, not fixed Tailwind ramps. The nine presets each
 * redefine `--success` / `--primary` / `--destructive` for their own surfaces,
 * and a pill that opts out is the only green in the app that is a different
 * green. Outlined rather than filled: a saturated block at the top of the
 * document out-shouts the attention queue, which is the thing that should draw
 * the eye first.
 */
const STATE_BADGE: Record<
  PrDisplayState,
  {
    readonly label: string;
    readonly className: string;
    readonly Icon: LucideIcon;
  }
> = {
  open: {
    label: "Open",
    className: "border-success/30 bg-success/10 text-success-foreground",
    Icon: GitPullRequestArrow,
  },
  draft: {
    label: "Draft",
    className: "border-border/60 bg-muted/50 text-muted-foreground",
    Icon: GitPullRequestDraft,
  },
  merged: {
    label: "Merged",
    className: "border-primary/30 bg-primary/10 text-primary",
    Icon: GitMerge,
  },
  closed: {
    label: "Closed",
    className: "border-destructive/30 bg-destructive/10 text-destructive",
    Icon: GitPullRequestClosed,
  },
};

const MERGE_SENTENCE_VERB: Record<PrDisplayState, string> = {
  open: "wants to merge changes",
  draft: "wants to merge changes",
  merged: "merged changes",
  closed: "wanted to merge changes",
};

function prDisplayState(core: PrDetailCore): PrDisplayState {
  return core.state === "open" && core.isDraft === true ? "draft" : core.state;
}

/**
 * GitHub-style PR header: wrapping title with a muted `#number`, then the
 * filled state pill + "{author} wants to merge changes into base from head"
 * sentence with branch chips, then a meta strip (diffstat, freshness).
 */
export function PrDetailHeader(props: {
  readonly core: PrDetailCore;
  readonly notLive: boolean;
  readonly observedAt: number | null;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
}): ReactNode {
  const title =
    props.core.title !== null && props.core.title.length > 0
      ? props.core.title
      : "Untitled pull request";
  const displayState = prDisplayState(props.core);
  const badge = STATE_BADGE[displayState];

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 items-start gap-2">
        <h1 className="min-w-0 flex-1 text-ui-lg leading-snug font-medium break-words text-foreground">
          {title}{" "}
          <span className="whitespace-nowrap text-muted-foreground">
            #{props.core.base.prNumber}
          </span>
        </h1>
        <div className="flex shrink-0 items-center gap-1">
          <PrDetailGitHubLink prUrl={props.core.prUrl} />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={props.onRefresh}
            aria-label="Refresh pull request"
            disabled={props.refreshing}
            data-testid="pr-detail-refresh"
            className="text-muted-foreground hover:text-foreground"
          >
            <RotateCcw
              className={cn("size-4", props.refreshing && "animate-spin")}
            />
          </Button>
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-ui-xs font-medium",
            badge.className,
          )}
          data-testid="pr-detail-state-badge"
          data-pr-state={displayState}
        >
          <badge.Icon className="size-4" aria-hidden />
          {badge.label}
        </span>
        <span className="min-w-0 text-ui-sm text-muted-foreground">
          <span className="font-medium text-foreground">
            {formatPrActorName(props.core.author)}
          </span>{" "}
          {MERGE_SENTENCE_VERB[displayState]} into{" "}
          <PrBranchChip name={props.core.baseRefName} /> from{" "}
          <PrBranchChip name={props.core.headRefName} />
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-ui-xs text-muted-foreground">
        {props.core.additions !== null && props.core.deletions !== null ? (
          <span className="font-mono">
            <span className={PR_DIFF_ADDED_CLASS}>+{props.core.additions}</span>{" "}
            <span className={PR_DIFF_REMOVED_CLASS}>
              −{props.core.deletions}
            </span>
          </span>
        ) : null}
        {props.core.commentCount !== null ? (
          <span>
            {props.core.commentCount} comment
            {props.core.commentCount === 1 ? "" : "s"}
          </span>
        ) : null}
        {props.notLive ? (
          <span
            className="rounded-full border border-border/60 px-1.5 py-0.5 text-ui-xs"
            data-testid="pr-detail-not-live"
          >
            Not live
          </span>
        ) : null}
        {props.observedAt !== null ? (
          <PrDetailStaleness observedAt={props.observedAt} />
        ) : null}
      </div>
    </div>
  );
}

/** GitHub's blue-tinted mono branch chip. */
function PrBranchChip(props: { readonly name: string | null }): ReactNode {
  return (
    <code className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-ui-xs break-all text-primary">
      {props.name !== null && props.name.length > 0 ? props.name : "unknown"}
    </code>
  );
}

function PrDetailStaleness(props: { readonly observedAt: number }): ReactNode {
  const label = useRelativeTimestamp(props.observedAt);
  return (
    <span data-testid="pr-detail-staleness">
      {label === "Just now" ? "Updated just now" : `Updated ${label}`}
    </span>
  );
}

function PrDetailGitHubLink(props: {
  readonly prUrl: string | null;
}): ReactNode {
  const runnerHost = use(RunnerHostContext);
  const openExternalLink = useRunnerOpenExternalLink();
  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>): void => {
      event.stopPropagation();
      if (props.prUrl === null || runnerHost === null) return;
      event.preventDefault();
      openExternalLink.mutate(props.prUrl);
    },
    [openExternalLink, props.prUrl, runnerHost],
  );

  if (props.prUrl === null) {
    return (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled
        aria-label="Open on GitHub"
        data-testid="pr-detail-github-link"
        className="h-7 text-ui-xs text-muted-foreground"
      >
        GitHub
        <ExternalLink className="size-3" aria-hidden />
      </Button>
    );
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      asChild
      className="h-7 text-ui-xs"
    >
      <a
        href={props.prUrl}
        target="_blank"
        rel="noreferrer"
        aria-label="Open on GitHub"
        data-testid="pr-detail-github-link"
        onClick={handleClick}
      >
        GitHub
        <ExternalLink className="size-3" aria-hidden />
      </a>
    </Button>
  );
}
