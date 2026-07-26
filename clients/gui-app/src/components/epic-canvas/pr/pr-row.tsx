import {
  use,
  useCallback,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  Check,
  CircleDashed,
  Clock,
  ExternalLink,
  Eye,
  GitBranch,
  MessageSquare,
  X,
  type LucideIcon,
} from "lucide-react";
import type { PrLightItem, PrState } from "@traycer/protocol/host/pr-schemas";
import { PrOwnerBadges } from "@/components/epic-canvas/pr/pr-owner-label";
import { Badge } from "@/components/ui/badge";
import { DropLine } from "@/components/ui/drop-line";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  PR_STATE_ICON,
  PR_STATE_PILL_CLASS,
  PR_STATE_TINT_CLASS,
} from "@/components/worktree/worktree-pr-state-palette";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useRunnerOpenExternalLink } from "@/hooks/runner/use-open-external-link-mutation";
import {
  formatPrBaseFromHead,
  formatPrRowTitle,
  formatPrStateLabel,
  fullyIdentifiedPrBase,
  prChecksSummary,
  prRowIdentityLabel,
  prRowTitleText,
  type PrChecksDotTone,
  type PrChecksSummary,
} from "@/lib/pr/pr-list-projection";
import { useRelativeTimestamp } from "@/lib/relative-time";
import { useIsActiveTile } from "@/stores/epics/canvas/store";
import { cn } from "@/lib/utils";
import { RunnerHostContext } from "@/providers/runner-host-context";

/**
 * Every badge on row 1 speaks the hover card's dialect: borderless tint,
 * `text-foreground` label, meaning carried by a tinted leading glyph. Only the
 * glyph is coloured, so three badges side by side read as three facts rather
 * than three alarms.
 */
const BADGE_CLASS = "gap-1 rounded-full px-2 font-medium";

const CHECKS_TONE: Record<
  PrChecksDotTone,
  {
    readonly Icon: LucideIcon;
    readonly surface: string;
    readonly glyph: string;
  }
> = {
  ok: {
    Icon: Check,
    surface: "border-transparent bg-green-500/10 text-foreground",
    glyph: "text-green-800 dark:text-green-300",
  },
  fail: {
    Icon: X,
    surface: "border-transparent bg-red-500/10 text-foreground",
    glyph: "text-red-800 dark:text-red-300",
  },
  pending: {
    Icon: Clock,
    surface: "border-transparent bg-amber-500/10 text-foreground",
    glyph: "text-amber-800 dark:text-amber-300",
  },
  none: {
    Icon: CircleDashed,
    surface: "border-transparent bg-muted/50 text-muted-foreground",
    glyph: "text-muted-foreground",
  },
};

const REVIEW_BADGE: Record<
  NonNullable<PrLightItem["reviewDecision"]>,
  {
    readonly label: string;
    readonly Icon: LucideIcon;
    readonly surface: string;
    readonly glyph: string;
  }
> = {
  approved: {
    label: "Approved",
    Icon: Check,
    surface: "border-transparent bg-green-500/10 text-foreground",
    glyph: "text-green-800 dark:text-green-300",
  },
  changes_requested: {
    label: "Changes requested",
    Icon: X,
    surface: "border-transparent bg-red-500/10 text-foreground",
    glyph: "text-red-800 dark:text-red-300",
  },
  review_required: {
    label: "Review required",
    Icon: Eye,
    surface: "border-transparent bg-muted/50 text-muted-foreground",
    glyph: "text-muted-foreground",
  },
};

export interface PrRowEntry {
  /** Stable list identity (`prListRowKey`). */
  readonly key: string;
  readonly item: PrLightItem;
  /**
   * The detail tile this row opens, for matching against the canvas's active
   * tile. `null` for an unknown-base row, which has no tile at all.
   */
  readonly tileId: string | null;
  /** `null` for an unknown-base row: no tile exists for it yet. */
  readonly onOpen: (() => void) | null;
}

/**
 * One PR as a flat list row - four bands, each with a single job, all sharing
 * one left edge:
 *
 *   1. badges: PR number (tinted by state), CI, review · time on the far right
 *   2. the title, truncated to one line
 *   3. `base ← head`
 *   4. the owning chat(s), as badges that open their tile
 *
 * Nothing wraps except by design, so a row is a fixed four-line block and a
 * list of them scans as four columns of the same kinds of thing. Row 1 is where
 * the state lives: the number badge carries it as tint + glyph (the hover
 * card's idiom), which is why there is no separate "Open" pill competing with
 * the title.
 *
 * Every PR gets this row, including an owned-submodule one: it sits in its own
 * repo group (see `orderRepoGroupKeys`, which places that group directly under
 * its superproject's) rather than collapsing to a one-line child. A submodule
 * PR is its own review, with its own checks and its own conversation, so it
 * gets the same four bands to say so.
 */
export function PrRow(props: {
  readonly entry: PrRowEntry;
  readonly epicId: string;
  readonly tabId: string;
}): ReactNode {
  const item = props.entry.item;
  const identified = fullyIdentifiedPrBase(item);
  const clickable = props.entry.onOpen !== null;
  const onOpen = props.entry.onOpen;
  // Mirrors how a chat/terminal row lights up when its tile is the one showing
  // (`useIsActiveEpicArtifact`); a PR tile is renderer-only, so it matches on
  // the tile id instead of an artifact record.
  const isActive = useIsActiveTile(props.tabId, props.entry.tileId);
  // The panel is an app-wide surface, so the reactive active host IS its
  // answer for a legacy owner with no recorded host. A canvas tile must
  // nominate its own bound host instead - see `PrOwnerBadges.fallbackHostId`.
  const activeHostId = useReactiveActiveHostId();

  const handleActivate = useCallback((): void => {
    onOpen?.();
  }, [onOpen]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      // Only the row itself activates on Enter/Space. Without this guard a
      // keydown on a nested badge bubbles up here and opens the detail tile in
      // addition to the badge's own action (and it's an invalid
      // nested-interactive pattern for assistive tech).
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onOpen?.();
      }
    },
    [onOpen],
  );

  return (
    <div
      className="group/pr-row flex min-w-0 flex-col"
      data-testid="pr-row"
      data-active={isActive ? "true" : "false"}
      data-pr-state={item.state}
      data-pr-identified={identified !== null ? "true" : "false"}
    >
      <div
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : undefined}
        aria-label={clickable ? `Open ${formatPrRowTitle(item)}` : undefined}
        onClick={clickable ? handleActivate : undefined}
        onKeyDown={clickable ? handleKeyDown : undefined}
        data-testid="pr-row-main"
        aria-current={isActive ? true : undefined}
        className={cn(
          "relative flex min-w-0 flex-col gap-1.5 py-2.5 pr-3 pl-3 text-left transition-colors",
          clickable &&
            "cursor-pointer focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 focus-visible:outline-none",
          // Selection reads as a WASH plus the rail's active bar, not the solid
          // `bg-accent` fill a chat/terminal row uses. Those rows are one line
          // of plain text, so a flat fill costs nothing; this row carries the
          // status palette (state tint, failing checks, review decision), and
          // most presets keep `--accent` a near-grey while `traycer-green` sets
          // it to its saturated `--primary` (#257174) - a full fill there stacks
          // the row's hues on a competing one and leaves the state glyph at
          // 3.08:1, the WCAG 1.4.11 graphic floor with nothing to spare. The
          // wash lifts the worst preset past 4:1 and keeps the same token, so
          // the sidebar still speaks one selection language. See
          // `pr-row.test.tsx`'s "PrRow selection surface" matrix.
          isActive ? "bg-accent/35" : clickable && "hover:bg-accent/20",
          item.state === "closed" && "opacity-70",
        )}
      >
        {isActive ? (
          <DropLine
            orientation="vertical"
            glow={false}
            className="absolute inset-y-1 left-0 rounded-l-none rounded-r"
            testId="pr-row-active-indicator"
          />
        ) : null}
        <PrRowBadges item={item} />
        <TooltipWrapper
          label={prRowTitleText(item)}
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <p
            className="min-w-0 truncate text-ui-sm font-medium text-foreground"
            data-testid="pr-row-title"
          >
            {prRowTitleText(item)}
          </p>
        </TooltipWrapper>
        <p className="flex min-w-0 items-center gap-1 font-mono text-ui-xs text-muted-foreground/80">
          <GitBranch className="size-3 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">{formatPrBaseFromHead(item)}</span>
        </p>
        <PrOwnerBadges
          owners={item.owners}
          epicId={props.epicId}
          fallbackHostId={activeHostId}
          className={undefined}
        />
      </div>
    </div>
  );
}

/** Row 1: identity + CI + review as badges, with freshness pinned right. */
function PrRowBadges(props: { readonly item: PrLightItem }): ReactNode {
  const checks = prChecksSummary(props.item.checksRollup);
  const review =
    props.item.reviewDecision === null
      ? null
      : REVIEW_BADGE[props.item.reviewDecision];
  const commentCount =
    props.item.commentCount !== null && props.item.commentCount > 0
      ? props.item.commentCount
      : null;
  return (
    // Band 1 stays ONE line at every width. Narrowing shrinks the badges
    // (`shrink` + `truncate`), and past the point where shrinking stops buying
    // anything a badge DROPS rather than sitting there as an unreadable sliver
    // - review first (longest label, and the whole decision is one click away
    // in the detail tile), checks next. The number badge never drops: it is the
    // row's identity and its tint is the row's state.
    //
    // Container queries, not viewport ones: this panel is user-resizable and
    // also renders inside a split pane, so only its OWN width is meaningful.
    <div className="@container flex min-w-0 items-start gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <PrNumberBadge item={props.item} />
        {checks === null ? null : <PrChecksBadge summary={checks} />}
        {review === null ? null : (
          <Badge
            variant="outline"
            // `shrink` overrides the variant's `shrink-0` so the longest label
            // ("Changes requested") truncates before anything is dropped.
            className={cn(
              BADGE_CLASS,
              "min-w-0 shrink @max-[17rem]:hidden",
              review.surface,
            )}
            data-testid="pr-row-review"
          >
            <review.Icon
              className={cn("size-3 shrink-0", review.glyph)}
              aria-hidden
            />
            <span className="truncate">{review.label}</span>
          </Badge>
        )}
      </div>
      <span className="flex shrink-0 items-center gap-2 pt-0.5 text-ui-xs text-muted-foreground/70">
        {props.item.liveness === "cache-only" ? (
          <span
            className="rounded-full border border-border/60 px-1.5"
            data-testid="pr-row-not-live"
          >
            Not live
          </span>
        ) : null}
        {commentCount === null ? null : (
          <span
            // Never dropped. It was briefly the first thing shed to buy the
            // review badge room, but a count that blinks out while you drag the
            // panel edge reads as a glitch rather than as a layout decision -
            // and unlike a badge it costs only ~30px.
            className="flex items-center gap-1"
            data-testid="pr-row-comments"
          >
            <MessageSquare className="size-3" aria-hidden />
            {commentCount}
            <span className="sr-only">
              comment{commentCount === 1 ? "" : "s"}
            </span>
          </span>
        )}
        {props.item.updatedAt === null ? null : (
          <PrRowUpdatedAt updatedAt={props.item.updatedAt} />
        )}
      </span>
    </div>
  );
}

/**
 * The PR number, tinted by state - the hover card's pill, reused. It is also
 * the row's GitHub link (the external-link glyph reveals on hover), so the
 * number carries three jobs at the width of one: identity, state, link out.
 */
function PrNumberBadge(props: { readonly item: PrLightItem }): ReactNode {
  const state: PrState = props.item.state;
  const StateIcon = PR_STATE_ICON[state];
  const label = prRowIdentityLabel(props.item);
  const prUrl = props.item.prUrl;
  const badgeClass = cn(
    "group/pr-pill shrink-0",
    BADGE_CLASS,
    PR_STATE_PILL_CLASS[state],
  );
  const glyph = (
    <StateIcon
      className={cn("size-3 shrink-0", PR_STATE_TINT_CLASS[state])}
      aria-hidden
      data-testid="pr-row-state-glyph"
    />
  );
  return (
    <TooltipWrapper
      label={formatPrStateLabel(state)}
      side="top"
      sideOffset={undefined}
      align="start"
    >
      {prUrl === null ? (
        <Badge
          variant="outline"
          className={badgeClass}
          data-testid="pr-row-number"
          data-pr-state={state}
        >
          {glyph}
          <span className="truncate tabular-nums">{label}</span>
        </Badge>
      ) : (
        <Badge asChild variant="outline" className={badgeClass}>
          {/* `asChild` hands the badge's own className to this child AS A PROP -
              a component child that doesn't forward it renders unstyled (and,
              without the badge's `inline-flex`, wraps its glyph onto its own
              line). Forward it explicitly; see `WorktreePrAnchor`. */}
          <PrNumberAnchor
            prUrl={prUrl}
            ariaLabel={`Open ${label} on GitHub`}
            className={undefined}
            state={state}
          >
            {glyph}
            <span className="truncate tabular-nums">{label}</span>
            {/* Opacity rather than conditional mount, so the badge's width is
                identical hovered and not - a row of them cannot reflow. */}
            <ExternalLink
              className="size-3 shrink-0 opacity-0 transition-opacity group-hover/pr-pill:opacity-60 group-focus-visible/pr-pill:opacity-60"
              aria-hidden
            />
          </PrNumberAnchor>
        </Badge>
      )}
    </TooltipWrapper>
  );
}

function PrChecksBadge(props: {
  readonly summary: PrChecksSummary;
}): ReactNode {
  const tone = CHECKS_TONE[props.summary.tone];
  return (
    <TooltipWrapper
      label={props.summary.detail}
      side="top"
      sideOffset={undefined}
      align="start"
    >
      <Badge
        variant="outline"
        className={cn(
          BADGE_CLASS,
          // Dropped only at the extreme, after the review badge has already
          // gone: its label is short, so it stays readable far longer.
          "shrink-0 tabular-nums @max-[13rem]:hidden",
          tone.surface,
        )}
        data-testid="pr-row-checks"
        data-tone={props.summary.tone}
      >
        <tone.Icon className={cn("size-3 shrink-0", tone.glyph)} aria-hidden />
        {props.summary.label}
      </Badge>
    </TooltipWrapper>
  );
}

function PrNumberAnchor(props: {
  readonly prUrl: string;
  readonly ariaLabel: string;
  /** Injected by `Badge asChild` (Radix Slot) - must land on the anchor. */
  readonly className: string | undefined;
  readonly state: PrState;
  readonly children: ReactNode;
}): ReactNode {
  const runnerHost = use(RunnerHostContext);
  const openExternalLink = useRunnerOpenExternalLink();
  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>): void => {
      // The row opens the detail tile; this badge means GitHub.
      event.stopPropagation();
      // No RunnerHost bound (e.g. web): let the browser handle the anchor
      // natively, preserving modifier-click/middle-click tab semantics.
      if (runnerHost === null) return;
      event.preventDefault();
      openExternalLink.mutate(props.prUrl);
    },
    [openExternalLink, props.prUrl, runnerHost],
  );
  return (
    <a
      href={props.prUrl}
      target="_blank"
      rel="noreferrer"
      aria-label={props.ariaLabel}
      className={props.className}
      data-testid="pr-row-number"
      data-pr-state={props.state}
      onClick={handleClick}
    >
      {props.children}
    </a>
  );
}

function PrRowUpdatedAt(props: { readonly updatedAt: number }): ReactNode {
  const label = useRelativeTimestamp(props.updatedAt);
  return (
    <span className="whitespace-nowrap" data-testid="pr-row-updated-at">
      {label}
    </span>
  );
}
