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
import {
  PR_STATE_PILL_CLASS,
  PR_STATE_TINT_CLASS,
} from "@/components/worktree/worktree-pr-state-palette";
import { useRunnerOpenExternalLink } from "@/hooks/runner/use-open-external-link-mutation";
import { formatPrActorName } from "@/lib/pr/pr-detail-projection";
import { useRelativeTimestamp } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { RunnerHostContext } from "@/providers/runner-host-context";

type PrDisplayState = PrState | "draft";

/**
 * The identity badge's surface and glyph tint, reusing the SHARED palette the
 * chat hover card and the PR panel row already render "PR number + state"
 * with. `worktree-pr-state-palette.ts` states outright that this idea must not
 * grow a second dialect, and a full view that invents its own pill is exactly
 * that - the same PR would carry two different greens depending on which
 * surface you were looking at.
 *
 * `draft` is the one state the shared palette has no entry for (it is a
 * modifier on `open`, not a `PrState`), so it gets the neutral treatment here:
 * a draft is open, but it is not asking to be merged.
 */
const DRAFT_PILL_CLASS = "border-transparent bg-muted/60 text-foreground";
const DRAFT_TINT_CLASS = "text-muted-foreground";

const STATE_GLYPH: Record<PrDisplayState, LucideIcon> = {
  open: GitPullRequestArrow,
  draft: GitPullRequestDraft,
  merged: GitMerge,
  closed: GitPullRequestClosed,
};

const STATE_LABEL: Record<PrDisplayState, string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
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
 * PR header: title, then one badge carrying state AND number together, the
 * "{author} wants to merge …" sentence with branch chips, and a meta strip.
 *
 * State and number were two separate things - a filled `Open` pill and a muted
 * `#4226` trailing the title. They are one fact about identity, they are
 * rendered as one badge everywhere else in the app, and splitting them here
 * spent two positions on it while leaving the title's own number competing
 * with the tab label's.
 */
export function PrDetailHeader(props: {
  readonly core: PrDetailCore;
  readonly notLive: boolean;
  readonly observedAt: number | null;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
  /** The tile's send-to-chat picker; the header is its one home. */
  readonly targetPicker: ReactNode;
}): ReactNode {
  const title =
    props.core.title !== null && props.core.title.length > 0
      ? props.core.title
      : "Untitled pull request";
  const displayState = prDisplayState(props.core);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 items-start gap-2">
        <h1 className="min-w-0 flex-1 text-ui-lg leading-snug font-medium break-words text-foreground">
          {title}
        </h1>
        <div className="flex shrink-0 items-center gap-1">
          {props.targetPicker}
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
        <PrDetailIdentityBadge
          state={displayState}
          prNumber={props.core.base.prNumber}
        />
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

/** State + number as one badge, in the shared PR-identity dialect. */
function PrDetailIdentityBadge(props: {
  readonly state: PrDisplayState;
  readonly prNumber: number;
}): ReactNode {
  const Glyph = STATE_GLYPH[props.state];
  const isDraft = props.state === "draft";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-ui-xs font-medium tabular-nums",
        isDraft ? DRAFT_PILL_CLASS : PR_STATE_PILL_CLASS[props.state],
      )}
      data-testid="pr-detail-state-badge"
      data-pr-state={props.state}
      title={STATE_LABEL[props.state]}
    >
      <Glyph
        className={cn(
          "size-3.5 shrink-0",
          isDraft ? DRAFT_TINT_CLASS : PR_STATE_TINT_CLASS[props.state],
        )}
        aria-hidden
      />
      <span className="sr-only">{STATE_LABEL[props.state]} </span>#
      {props.prNumber}
    </span>
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
