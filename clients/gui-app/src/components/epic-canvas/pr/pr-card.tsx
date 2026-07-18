import {
  use,
  useCallback,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { ExternalLink } from "lucide-react";
import type { PrLightItem } from "@traycer/protocol/host/pr-schemas";
import { PrOwnerLabel } from "@/components/epic-canvas/pr/pr-owner-label";
import { PrStatePill } from "@/components/epic-canvas/pr/pr-state-pill";
import { Button } from "@/components/ui/button";
import { useRunnerOpenExternalLink } from "@/hooks/runner/use-open-external-link-mutation";
import {
  formatPrBranchSummary,
  formatPrChecksRollup,
  formatPrReviewDecision,
  formatPrRowTitle,
  fullyIdentifiedPrBase,
  prChecksDotTone,
} from "@/lib/pr/pr-list-projection";
import { useRelativeTimestamp } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { RunnerHostContext } from "@/providers/runner-host-context";

const CHECKS_DOT_CLASS = {
  ok: "bg-green-600 dark:bg-green-400",
  fail: "bg-red-600 dark:bg-red-400",
  pending: "bg-amber-500 dark:bg-amber-400",
  none: "bg-muted-foreground/30",
} as const;

/**
 * One PR as a small always-expanded card (no accordion - an epic rarely has
 * more than a handful of PRs, so every card shows its summary directly).
 * Clicking the card opens the full-view tile; `onOpen: null` marks an
 * unknown-base row that has no tile yet (its base coordinates are still
 * resolving), rendered non-interactive. The GitHub link is the only inner
 * button and stops propagation.
 */
export function PrCard(props: {
  readonly item: PrLightItem;
  readonly onOpen: (() => void) | null;
}): ReactNode {
  const owner = props.item.owners[0] ?? null;
  const tone = prChecksDotTone(props.item.checksRollup);
  const identified = fullyIdentifiedPrBase(props.item);
  const isClosed = props.item.state === "closed";
  const clickable = props.onOpen !== null;

  const handleActivate = useCallback((): void => {
    props.onOpen?.();
  }, [props]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      // Only the card itself activates on Enter/Space. Without this guard a
      // keydown on the nested GitHub anchor bubbles up here and opens the
      // detail tile in addition to following the link (and it's an invalid
      // nested-interactive pattern for assistive tech).
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        props.onOpen?.();
      }
    },
    [props],
  );

  return (
    <div
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-label={
        clickable ? `Open ${formatPrRowTitle(props.item)}` : undefined
      }
      onClick={clickable ? handleActivate : undefined}
      onKeyDown={clickable ? handleKeyDown : undefined}
      data-testid="pr-card"
      data-pr-state={props.item.state}
      data-pr-identified={identified !== null ? "true" : "false"}
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-lg border border-border/60 bg-background/40 px-2.5 py-2 text-left transition-colors",
        clickable &&
          "cursor-pointer hover:border-border hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        isClosed && "opacity-70",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            CHECKS_DOT_CLASS[tone],
          )}
          aria-hidden
          data-testid="pr-checks-dot"
          data-tone={tone}
        />
        <span className="min-w-0 flex-1 truncate text-ui-sm font-medium text-foreground">
          {formatPrRowTitle(props.item)}
        </span>
        <PrStatePill state={props.item.state} className={undefined} />
      </div>
      <p className="truncate font-mono text-ui-xs text-muted-foreground">
        {formatPrBranchSummary(props.item)}
      </p>
      <p className="truncate text-ui-xs text-muted-foreground">
        {formatPrCardMeta(props.item)}
      </p>
      <div className="flex min-w-0 items-center gap-1.5">
        <PrOwnerLabel owner={owner} className="min-w-0 flex-1" />
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {props.item.updatedAt !== null ? (
            <PrCardUpdatedAt updatedAt={props.item.updatedAt} />
          ) : null}
          {props.item.prUrl !== null ? (
            <PrCardGitHubLink prUrl={props.item.prUrl} />
          ) : null}
        </span>
      </div>
    </div>
  );
}

function formatPrCardMeta(item: PrLightItem): string {
  const commentLabel =
    item.commentCount === null
      ? null
      : `${item.commentCount} comment${item.commentCount === 1 ? "" : "s"}`;
  return [
    formatPrChecksRollup(item.checksRollup),
    formatPrReviewDecision(item.reviewDecision),
    commentLabel,
    item.liveness === "cache-only" ? "Not live" : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

function PrCardUpdatedAt(props: { readonly updatedAt: number }): ReactNode {
  const label = useRelativeTimestamp(props.updatedAt);
  return (
    <span
      className="text-ui-xs whitespace-nowrap text-muted-foreground/70"
      data-testid="pr-card-updated-at"
    >
      {label}
    </span>
  );
}

function PrCardGitHubLink(props: { readonly prUrl: string }): ReactNode {
  const runnerHost = use(RunnerHostContext);
  const openExternalLink = useRunnerOpenExternalLink();
  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>): void => {
      event.stopPropagation();
      if (runnerHost === null) return;
      event.preventDefault();
      openExternalLink.mutate(props.prUrl);
    },
    [openExternalLink, props.prUrl, runnerHost],
  );

  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      asChild
      className="-my-1 -mr-1 text-muted-foreground hover:text-foreground"
    >
      <a
        href={props.prUrl}
        target="_blank"
        rel="noreferrer"
        aria-label="Open on GitHub"
        data-testid="pr-github-link"
        onClick={handleClick}
      >
        <ExternalLink className="size-3.5" aria-hidden />
      </a>
    </Button>
  );
}
