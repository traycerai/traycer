import {
  use,
  useCallback,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { ChevronRight, ExternalLink } from "lucide-react";
import type { PrLightItem } from "@traycer/protocol/host/pr-schemas";
import { PrOwnerLabel } from "@/components/epic-canvas/pr/pr-owner-label";
import { PrStatePill } from "@/components/epic-canvas/pr/pr-state-pill";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useRunnerOpenExternalLink } from "@/hooks/runner/use-open-external-link-mutation";
import {
  formatPrBranchSummary,
  formatPrChecksRollup,
  formatPrReviewDecision,
  formatPrRowTitle,
  fullyIdentifiedPrBase,
  prChecksDotTone,
} from "@/lib/pr/pr-list-projection";
import { cn } from "@/lib/utils";
import { RunnerHostContext } from "@/providers/runner-host-context";

const CHECKS_DOT_CLASS = {
  ok: "bg-green-600 dark:bg-green-400",
  fail: "bg-red-600 dark:bg-red-400",
  pending: "bg-amber-500 dark:bg-amber-400",
  none: "bg-muted-foreground/30",
} as const;

export function PrListRow(props: {
  readonly item: PrLightItem;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onOpenFullView: (() => void) | null;
}): ReactNode {
  const owner = props.item.owners[0] ?? null;
  const tone = prChecksDotTone(props.item.checksRollup);
  const identified = fullyIdentifiedPrBase(props.item);
  const isClosed = props.item.state === "closed";

  const handleActivate = useCallback((): void => {
    props.onToggle();
  }, [props]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        props.onToggle();
      }
    },
    [props],
  );

  return (
    <div
      className={cn(
        "rounded-md border border-border/60 bg-background/40",
        props.expanded && "border-border bg-muted/20",
        isClosed && "opacity-70",
      )}
      data-testid="pr-list-row"
      data-pr-expanded={props.expanded ? "true" : "false"}
      data-pr-state={props.item.state}
      data-pr-identified={identified !== null ? "true" : "false"}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={props.expanded}
        className="flex w-full min-w-0 cursor-pointer items-start gap-1.5 px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={handleActivate}
        onKeyDown={handleKeyDown}
        data-testid="pr-list-row-header"
      >
        <ChevronRight
          className={cn(
            "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform",
            props.expanded && "rotate-90",
          )}
          aria-hidden
        />
        <span
          className={cn(
            "mt-1 size-1.5 shrink-0 rounded-full",
            CHECKS_DOT_CLASS[tone],
          )}
          aria-hidden
          data-testid="pr-checks-dot"
          data-tone={tone}
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground">
              {formatPrRowTitle(props.item)}
            </span>
            <PrStatePill state={props.item.state} className={undefined} />
          </div>
          <PrOwnerLabel owner={owner} className="mt-0.5 block" />
          {props.item.liveness === "cache-only" ? (
            <span className="mt-0.5 block text-ui-xs text-muted-foreground/70">
              Not live
            </span>
          ) : null}
        </div>
      </div>
      {props.expanded ? (
        <PrListRowExpanded
          item={props.item}
          onOpenFullView={props.onOpenFullView}
        />
      ) : null}
    </div>
  );
}

function formatPrCommentLabel(commentCount: number | null): string {
  if (commentCount === null) return "Comments unknown";
  if (commentCount === 1) return "1 comment";
  return `${commentCount} comments`;
}

function PrListRowExpanded(props: {
  readonly item: PrLightItem;
  readonly onOpenFullView: (() => void) | null;
}): ReactNode {
  const commentLabel = formatPrCommentLabel(props.item.commentCount);

  return (
    <div
      className="space-y-2 border-t border-border/50 px-2 py-2"
      data-testid="pr-list-row-expanded"
    >
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-ui-xs">
        <dt className="text-muted-foreground">Branch</dt>
        <dd className="min-w-0 truncate text-foreground">
          {formatPrBranchSummary(props.item)}
        </dd>
        <dt className="text-muted-foreground">Checks</dt>
        <dd className="min-w-0 truncate text-foreground">
          {formatPrChecksRollup(props.item.checksRollup)}
        </dd>
        <dt className="text-muted-foreground">Review</dt>
        <dd className="min-w-0 truncate text-foreground">
          {formatPrReviewDecision(props.item.reviewDecision)} · {commentLabel}
        </dd>
      </dl>
      <div className="flex flex-wrap items-center gap-1.5">
        {props.onOpenFullView !== null ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={props.onOpenFullView}
            aria-label="Open full view"
            data-testid="pr-open-full-view"
            className="h-7 text-ui-xs"
          >
            Open full view
          </Button>
        ) : (
          <TooltipWrapper
            label="Full identity is still resolving"
            side="bottom"
            sideOffset={4}
            align="start"
          >
            <span className="inline-flex">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled
                aria-label="Open full view"
                data-testid="pr-open-full-view"
                className="h-7 text-ui-xs"
              >
                Open full view
              </Button>
            </span>
          </TooltipWrapper>
        )}
        <PrGitHubLink prUrl={props.item.prUrl} />
      </div>
      {props.onOpenFullView === null ? (
        <p className="text-ui-xs text-muted-foreground/70">
          Full identity is still resolving — expansion is not remembered yet.
        </p>
      ) : null}
    </div>
  );
}

function PrGitHubLink(props: { readonly prUrl: string | null }): ReactNode {
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
        data-testid="pr-github-link"
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
        data-testid="pr-github-link"
        onClick={handleClick}
      >
        GitHub
        <ExternalLink className="size-3" aria-hidden />
      </a>
    </Button>
  );
}
