import type { ReactNode } from "react";
import {
  ArrowRight,
  Check,
  ChevronRight,
  Clock,
  Eye,
  GitCommitHorizontal,
  GitMerge,
  MessageSquare,
  Minus,
  Plus,
  X,
  type LucideIcon,
} from "lucide-react";
import type {
  PrActivityItem,
  PrActivitySection,
  PrActor,
  PrChecksSection,
  PrCommit,
  PrCommitsSection,
  PrDetailCore,
  PrFilesSection,
  PrReviewState,
} from "@traycer/protocol/host/pr-schemas";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { PrActorAvatar } from "@/components/epic-canvas/pr/pr-detail-avatar";
import { TraycerMarkdown } from "@/markdown/traycer-markdown";
import {
  formatPrActorName,
  formatPrCheckStatusLabel,
  prActivityItemKey,
  prCheckContextDotTone,
} from "@/lib/pr/pr-detail-projection";
import { useRelativeTimestamp } from "@/lib/relative-time";
import { cn } from "@/lib/utils";

// GitHub timeline geometry (Primer TimelineItem): a single left gutter, the
// width of a comment avatar (size-10 = 2.5rem), with the 2px connector line
// running through its CENTER (left-5 = 1.25rem). Comment avatars sit at the
// gutter's left and are centered on the line; event badges (size-8 = 2rem)
// are centered inside a matching 2.5rem gutter so they land on the same line.
// Both are opaque (bg-canvas / ring-canvas), so the line shows only in the
// gap between items. The card / text column begins just past the gutter at
// 2.75rem (gap-1 after the 2.5rem avatar; ml-11/pl-11 for the merge box,
// files card, review bodies, and "view older" link), so nothing overlaps the
// line and every avatar/badge threads it.

type PrTimelineEntry =
  | { readonly kind: "activity"; readonly item: PrActivityItem }
  | { readonly kind: "commit"; readonly commit: PrCommit };

function timelineEntryTimestamp(entry: PrTimelineEntry): number {
  if (entry.kind === "activity") return entry.item.createdAt;
  // Commits without a committedDate sort first - they predate discussion.
  return entry.commit.committedAt ?? Number.NEGATIVE_INFINITY;
}

/**
 * GitHub-style conversation timeline: the description as the first comment
 * card, then commits (as micro-events) interleaved chronologically with
 * comments and review events along the connector line, ending with a "view
 * older" link when either feed is truncated.
 */
export function PrDetailTimeline(props: {
  readonly core: PrDetailCore;
  readonly activity: PrActivitySection;
  readonly commits: PrCommitsSection;
}): ReactNode {
  const entries: readonly PrTimelineEntry[] = [
    ...props.activity.items.map(
      (item) => ({ kind: "activity", item }) as const,
    ),
    ...props.commits.commits.map(
      (commit) => ({ kind: "commit", commit }) as const,
    ),
  ].sort(
    (left, right) =>
      timelineEntryTimestamp(left) - timelineEntryTimestamp(right),
  );
  const showOlderLink =
    (props.activity.isTruncated || props.commits.isTruncated) &&
    props.core.prUrl !== null;

  return (
    <div
      className="relative flex min-w-0 flex-col gap-4 before:absolute before:top-2 before:bottom-2 before:left-5 before:w-0.5 before:bg-border/70"
      data-testid="pr-detail-timeline"
    >
      <PrTimelineCardItem
        actor={props.core.author}
        headline="commented"
        timestamp={null}
        body={props.core.body ?? ""}
        emptyBody="No description provided."
        testId="pr-detail-description"
      />
      {entries.map((entry) =>
        entry.kind === "activity" ? (
          <PrTimelineActivityItem
            key={prActivityItemKey(entry.item)}
            item={entry.item}
          />
        ) : (
          <PrTimelineCommitItem
            key={`commit:${entry.commit.oid}`}
            commit={entry.commit}
            prUrl={props.core.prUrl}
          />
        ),
      )}
      {showOlderLink && props.core.prUrl !== null ? (
        <div className="pl-11">
          <a
            href={props.core.prUrl}
            target="_blank"
            rel="noreferrer"
            className="text-ui-xs text-primary hover:underline"
          >
            View older activity on GitHub
          </a>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A commit as GitHub's conversation micro-event: bare commit glyph on the
 * connector line, author avatar, message headline, short sha linking out.
 */
function PrTimelineCommitItem(props: {
  readonly commit: PrCommit;
  readonly prUrl: string | null;
}): ReactNode {
  const shortOid = props.commit.oid.slice(0, 7);
  const actor =
    props.commit.author ??
    (props.commit.authorName !== null && props.commit.authorName.length > 0
      ? { login: props.commit.authorName, avatarUrl: null }
      : null);
  return (
    <div
      className="flex min-w-0 items-center gap-1 text-ui-xs text-muted-foreground"
      data-testid="pr-detail-commit-item"
    >
      <span className="flex w-10 shrink-0 justify-center" aria-hidden>
        <span className="flex size-8 items-center justify-center rounded-full bg-canvas text-muted-foreground ring-2 ring-canvas">
          <GitCommitHorizontal className="size-4" />
        </span>
      </span>
      <PrActorAvatar actor={actor} size="sm" className={undefined} />
      <span className="min-w-0 flex-1 truncate">
        {props.commit.messageHeadline ?? shortOid}
      </span>
      {props.prUrl !== null ? (
        <a
          href={`${props.prUrl}/commits/${props.commit.oid}`}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 font-mono hover:text-foreground hover:underline"
        >
          {shortOid}
        </a>
      ) : (
        <span className="shrink-0 font-mono">{shortOid}</span>
      )}
    </div>
  );
}

function PrTimelineActivityItem(props: {
  readonly item: PrActivityItem;
}): ReactNode {
  if (props.item.kind === "comment") {
    return (
      <PrTimelineCardItem
        actor={props.item.author}
        headline="commented"
        timestamp={props.item.createdAt}
        body={props.item.body}
        emptyBody="No content."
        testId="pr-detail-activity-item"
      />
    );
  }
  return <PrTimelineReviewItem item={props.item} />;
}

/** Avatar in the gutter + a bordered comment card, GitHub's comment anatomy. */
function PrTimelineCardItem(props: {
  readonly actor: PrActor | null;
  readonly headline: string;
  readonly timestamp: number | null;
  readonly body: string;
  readonly emptyBody: string;
  readonly testId: string;
}): ReactNode {
  return (
    <div className="flex min-w-0 items-start gap-1" data-testid={props.testId}>
      <PrActorAvatar actor={props.actor} size="lg" className={undefined} />
      <PrCommentCard
        author={props.actor}
        headline={props.headline}
        timestamp={props.timestamp}
        body={props.body}
        emptyBody={props.emptyBody}
      />
    </div>
  );
}

function PrCommentCard(props: {
  readonly author: PrActor | null;
  readonly headline: string;
  readonly timestamp: number | null;
  readonly body: string;
  readonly emptyBody: string;
}): ReactNode {
  return (
    <div className="min-w-0 flex-1 overflow-hidden rounded-md border border-border/70 bg-canvas">
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 border-b border-border/70 bg-muted/40 px-3 py-2 text-ui-xs text-muted-foreground">
        <span className="font-semibold text-foreground">
          {formatPrActorName(props.author)}
        </span>
        <span>{props.headline}</span>
        {props.timestamp !== null ? (
          <PrRelativeTime timestamp={props.timestamp} />
        ) : null}
      </div>
      <div className="px-3 py-3">
        {props.body.length === 0 ? (
          <p className="text-ui-sm text-muted-foreground/70 italic">
            {props.emptyBody}
          </p>
        ) : (
          <TraycerMarkdown
            className={null}
            proseSize="compact"
            components={null}
            remarkPlugins={null}
            rehypePlugins={null}
            quotable={false}
            isStreaming={false}
          >
            {props.body}
          </TraycerMarkdown>
        )}
      </div>
    </div>
  );
}

const REVIEW_EVENT: Record<
  PrReviewState,
  {
    readonly sentence: string;
    readonly iconClass: string;
    readonly Icon: LucideIcon;
  }
> = {
  approved: {
    sentence: "approved these changes",
    iconClass: "bg-green-600 text-white dark:bg-green-700",
    Icon: Check,
  },
  changes_requested: {
    sentence: "requested changes",
    iconClass: "bg-red-600 text-white dark:bg-red-700",
    Icon: X,
  },
  commented: {
    sentence: "reviewed",
    iconClass: "bg-muted text-muted-foreground",
    Icon: Eye,
  },
  dismissed: {
    sentence: "dismissed a review",
    iconClass: "bg-muted text-muted-foreground",
    Icon: X,
  },
  pending: {
    sentence: "started a review",
    iconClass: "bg-muted text-muted-foreground",
    Icon: Clock,
  },
};

/**
 * A review as GitHub renders it: a compact event line on the connector
 * (state icon + "{login} approved these changes"), with the review body -
 * when present - as a comment card indented to the card gutter below.
 */
function PrTimelineReviewItem(props: {
  readonly item: PrActivityItem & { readonly kind: "review" };
}): ReactNode {
  const event = REVIEW_EVENT[props.item.state];
  return (
    <div
      className="flex min-w-0 flex-col gap-2"
      data-testid="pr-detail-activity-item"
    >
      <div className="flex min-w-0 items-center gap-1 text-ui-xs text-muted-foreground">
        <span className="flex w-10 shrink-0 justify-center" aria-hidden>
          <span
            className={cn(
              "flex size-8 items-center justify-center rounded-full ring-2 ring-canvas",
              event.iconClass,
            )}
          >
            <event.Icon className="size-4" />
          </span>
        </span>
        <PrActorAvatar
          actor={props.item.author}
          size="sm"
          className={undefined}
        />
        <span className="min-w-0">
          <span className="font-semibold text-foreground">
            {formatPrActorName(props.item.author)}
          </span>{" "}
          {event.sentence}
        </span>
        <PrRelativeTime timestamp={props.item.createdAt} />
      </div>
      {props.item.body.length > 0 ? (
        <div className="flex min-w-0 pl-11">
          <PrCommentCard
            author={props.item.author}
            headline="left a comment"
            timestamp={null}
            body={props.item.body}
            emptyBody=""
          />
        </div>
      ) : null}
    </div>
  );
}

function PrRelativeTime(props: { readonly timestamp: number }): ReactNode {
  const label = useRelativeTimestamp(props.timestamp);
  return <span className="whitespace-nowrap">{label}</span>;
}

// ---- Files changed --------------------------------------------------------- //

const FILE_GLYPH_CLASS = {
  added: "text-green-600 dark:text-green-400",
  deleted: "text-red-600 dark:text-red-400",
  renamed: "text-muted-foreground",
  copied: "text-muted-foreground",
} as const;

function PrFileChangeGlyph(props: {
  readonly changeType: PrFilesSection["files"][number]["changeType"];
}): ReactNode {
  if (props.changeType === "added") {
    return (
      <Plus
        className={cn("size-3.5 shrink-0", FILE_GLYPH_CLASS.added)}
        aria-hidden
      />
    );
  }
  if (props.changeType === "deleted") {
    return (
      <Minus
        className={cn("size-3.5 shrink-0", FILE_GLYPH_CLASS.deleted)}
        aria-hidden
      />
    );
  }
  if (props.changeType === "renamed" || props.changeType === "copied") {
    return (
      <ArrowRight
        className={cn("size-3.5 shrink-0", FILE_GLYPH_CLASS.renamed)}
        aria-hidden
      />
    );
  }
  // modified / changed / unknown - GitHub's yellow "modified" square.
  return (
    <span
      className="mx-0.5 size-2.5 shrink-0 rounded-xs bg-amber-500/80"
      aria-hidden
    />
  );
}

/**
 * GitHub's "Files changed" list, reduced to what v1 carries: per-file paths,
 * change type, and +/− counts (no patch content). Header links out to the
 * PR's files tab for the actual diff.
 */
export function PrDetailFilesChanged(props: {
  readonly files: PrFilesSection;
  readonly prUrl: string | null;
  // PR-wide diffstat from `core`. The header must show these, NOT the sum of
  // the shown (≤100) file rows: on a >100-file PR the row sum covers only the
  // first 100 while `totalCount` covers all, so pairing them would read as a
  // total that doesn't add up. Fall back to the shown sum only when the
  // PR-wide values are absent (never observed).
  readonly additions: number | null;
  readonly deletions: number | null;
}): ReactNode {
  if (props.files.files.length === 0) return null;
  const shownCount = props.files.files.length;
  const totalCount = props.files.totalCount ?? shownCount;
  const additions =
    props.additions ??
    props.files.files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions =
    props.deletions ??
    props.files.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);

  return (
    <Collapsible
      defaultOpen
      className="mt-5 ml-11 overflow-hidden rounded-md border border-border/70 bg-canvas"
      data-testid="pr-detail-files"
    >
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/20">
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        <span className="text-ui-sm font-semibold text-foreground">
          Files changed
        </span>
        <span className="text-ui-xs text-muted-foreground">{totalCount}</span>
        <span className="ml-auto shrink-0 font-mono text-ui-xs">
          <span className="text-green-700 dark:text-green-400">
            +{additions}
          </span>{" "}
          <span className="text-red-700 dark:text-red-400">−{deletions}</span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="max-h-80 divide-y divide-border/50 overflow-y-auto border-t border-border/50">
          {props.files.files.map((file) => (
            <li
              key={file.path}
              className="flex items-center gap-2 px-3 py-1.5 text-ui-xs"
              data-testid="pr-detail-file-row"
            >
              <PrFileChangeGlyph changeType={file.changeType} />
              <span
                className="min-w-0 flex-1 truncate font-mono text-foreground"
                title={file.path}
              >
                {file.path}
              </span>
              <span className="shrink-0 font-mono text-muted-foreground">
                {file.additions !== null ? (
                  <span className="text-green-700 dark:text-green-400">
                    +{file.additions}
                  </span>
                ) : null}{" "}
                {file.deletions !== null ? (
                  <span className="text-red-700 dark:text-red-400">
                    −{file.deletions}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
        {props.files.isTruncated || totalCount > shownCount ? (
          <p className="border-t border-border/50 px-3 py-1.5 text-ui-xs text-muted-foreground/70">
            Showing the first {shownCount} of {totalCount} files.{" "}
            {props.prUrl !== null ? (
              <a
                href={`${props.prUrl}/files`}
                target="_blank"
                rel="noreferrer"
                className="text-primary hover:underline"
              >
                View all on GitHub
              </a>
            ) : null}
          </p>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

// ---- Merge box ------------------------------------------------------------ //

type PrMergeTone = "ok" | "fail" | "pending" | "merged" | "neutral";

const MERGE_TONE_ICON_CLASS: Record<PrMergeTone, string> = {
  ok: "bg-green-600 text-white dark:bg-green-700",
  fail: "bg-red-600 text-white dark:bg-red-700",
  pending: "bg-amber-500 text-white",
  merged: "bg-purple-600 text-white dark:bg-purple-700",
  neutral: "bg-muted text-muted-foreground",
};

/**
 * GitHub's merge-box: a bordered stack of status rows - review decision,
 * checks summary with the per-check list, and the merged/closed state.
 * Read-only v1: no merge actions, only the facts GitHub would show there.
 */
export function PrDetailMergeBox(props: {
  readonly core: PrDetailCore;
  readonly checks: PrChecksSection;
}): ReactNode {
  const reviewRow =
    props.core.state === "open" ? reviewDecisionRow(props.core) : null;
  const showChecks = props.checks.contexts.length > 0;
  const stateRow = mergeStateRow(props.core);
  if (reviewRow === null && !showChecks && stateRow === null) return null;

  return (
    <div
      className="mt-5 ml-11 divide-y divide-border/70 overflow-hidden rounded-md border border-border/70"
      data-testid="pr-detail-merge-box"
    >
      {reviewRow !== null ? (
        <PrMergeBoxRow
          tone={reviewRow.tone}
          Icon={reviewRow.Icon}
          title={reviewRow.title}
          subtitle={reviewRow.subtitle}
        />
      ) : null}
      {showChecks ? <PrMergeBoxChecks checks={props.checks} /> : null}
      {stateRow !== null ? (
        <PrMergeBoxRow
          tone={stateRow.tone}
          Icon={stateRow.Icon}
          title={stateRow.title}
          subtitle={stateRow.subtitle}
        />
      ) : null}
    </div>
  );
}

interface PrMergeBoxRowContent {
  readonly tone: PrMergeTone;
  readonly Icon: LucideIcon;
  readonly title: string;
  readonly subtitle: string | null;
}

function reviewDecisionRow(core: PrDetailCore): PrMergeBoxRowContent | null {
  if (core.reviewDecision === null) return null;
  if (core.reviewDecision === "approved") {
    return {
      tone: "ok",
      Icon: Check,
      title: "Changes approved",
      subtitle: "This pull request has an approving review.",
    };
  }
  if (core.reviewDecision === "changes_requested") {
    return {
      tone: "fail",
      Icon: X,
      title: "Changes requested",
      subtitle: "A review requested changes on this pull request.",
    };
  }
  return {
    tone: "pending",
    Icon: Eye,
    title: "Review required",
    subtitle: "An approving review is required before merging.",
  };
}

function mergeStateRow(core: PrDetailCore): PrMergeBoxRowContent | null {
  if (core.state === "merged") {
    return {
      tone: "merged",
      Icon: GitMerge,
      title: "Pull request successfully merged and closed",
      subtitle: null,
    };
  }
  if (core.state === "closed") {
    return {
      tone: "fail",
      Icon: X,
      title: "Closed with unmerged changes",
      subtitle: "This pull request was closed without merging.",
    };
  }
  return null;
}

function PrMergeBoxRow(props: {
  readonly tone: PrMergeTone;
  readonly Icon: LucideIcon;
  readonly title: string;
  readonly subtitle: string | null;
}): ReactNode {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full",
          MERGE_TONE_ICON_CLASS[props.tone],
        )}
        aria-hidden
      >
        <props.Icon className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="text-ui-sm font-semibold text-foreground">
          {props.title}
        </p>
        {props.subtitle !== null ? (
          <p className="text-ui-xs text-muted-foreground">{props.subtitle}</p>
        ) : null}
      </div>
    </div>
  );
}

function checksHeadline(checks: PrChecksSection): PrMergeBoxRowContent {
  const tones = checks.contexts.map(prCheckContextDotTone);
  const failing = tones.filter((tone) => tone === "fail").length;
  const pending = tones.filter((tone) => tone === "pending").length;
  const successful = tones.filter((tone) => tone === "ok").length;
  const counts = [
    failing > 0 ? `${failing} failing` : null,
    pending > 0 ? `${pending} pending` : null,
    successful > 0 ? `${successful} successful` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
  const plural = checks.contexts.length === 1 ? "check" : "checks";
  const subtitle =
    counts.length > 0
      ? `${counts} ${plural}`
      : `${checks.contexts.length} ${plural}`;
  if (failing > 0) {
    return {
      tone: "fail",
      Icon: X,
      title: "Some checks were not successful",
      subtitle,
    };
  }
  if (pending > 0) {
    return {
      tone: "pending",
      Icon: Clock,
      title: "Some checks haven't completed yet",
      subtitle,
    };
  }
  if (successful > 0) {
    return {
      tone: "ok",
      Icon: Check,
      title: "All checks have passed",
      subtitle,
    };
  }
  return {
    tone: "neutral",
    Icon: MessageSquare,
    title: "Checks reported",
    subtitle,
  };
}

const CHECK_ROW_ICON_CLASS = {
  ok: "text-green-600 dark:text-green-400",
  fail: "text-red-600 dark:text-red-400",
} as const;

const CHECK_ROW_DOT_CLASS = {
  pending: "bg-amber-500 dark:bg-amber-400",
  none: "bg-muted-foreground/40",
} as const;

function PrMergeBoxChecks(props: {
  readonly checks: PrChecksSection;
}): ReactNode {
  const headline = checksHeadline(props.checks);
  return (
    <div data-testid="pr-detail-checks">
      <PrMergeBoxRow
        tone={headline.tone}
        Icon={headline.Icon}
        title={headline.title}
        subtitle={headline.subtitle}
      />
      <ul className="max-h-64 divide-y divide-border/50 overflow-y-auto border-t border-border/50 bg-muted/20">
        {props.checks.contexts.map((context) => {
          const tone = prCheckContextDotTone(context);
          return (
            <li
              key={context.name}
              className="flex items-center gap-2 px-3 py-1.5 text-ui-xs"
            >
              {tone === "ok" || tone === "fail" ? (
                <PrCheckRowIcon tone={tone} />
              ) : (
                <span
                  className={cn(
                    "mx-1 size-2 shrink-0 rounded-full",
                    CHECK_ROW_DOT_CLASS[tone],
                  )}
                  aria-hidden
                  data-testid="pr-detail-check-dot"
                />
              )}
              <span className="min-w-0 flex-1 truncate text-foreground">
                {context.name}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {formatPrCheckStatusLabel(context)}
              </span>
              {context.detailsUrl !== null ? (
                <a
                  href={context.detailsUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Open ${context.name} on GitHub`}
                  className="shrink-0 text-primary hover:underline"
                >
                  Details
                </a>
              ) : null}
            </li>
          );
        })}
      </ul>
      {props.checks.isTruncated ? (
        <p className="border-t border-border/50 px-3 py-1.5 text-ui-xs text-muted-foreground/70">
          Showing the first 50 checks.
        </p>
      ) : null}
    </div>
  );
}

function PrCheckRowIcon(props: { readonly tone: "ok" | "fail" }): ReactNode {
  const Icon = props.tone === "ok" ? Check : X;
  return (
    <Icon
      className={cn("size-4 shrink-0", CHECK_ROW_ICON_CLASS[props.tone])}
      aria-hidden
      data-testid="pr-detail-check-dot"
    />
  );
}
