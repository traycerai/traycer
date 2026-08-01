import {
  useCallback,
  useMemo,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import {
  Check,
  Clock,
  Eye,
  FileCode,
  TextQuote,
  X,
  type LucideIcon,
} from "lucide-react";
import type {
  PrActivityItem,
  PrActivitySection,
  PrDetailCore,
  PrReviewState,
  PrReviewThread,
  PrReviewThreadsSection,
} from "@traycer/protocol/host/pr-schemas";
import {
  groupPrConversation,
  partitionThreadsByResolution,
  prReviewThreadAnchor,
  type PrConversationEntry,
  type PrReviewActivityItem,
} from "@/lib/pr/pr-conversation";
import { buildPrReviewHunkPatch } from "@/lib/pr/pr-review-hunk";
import {
  DiffContentFrame,
  DiffContentPrimitive,
} from "@/components/diff/diff-content-primitive";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { PrExternalGitHubLink } from "@/components/epic-canvas/pr/pr-external-github-link";
import {
  formatPrActorName,
  formatPrReviewStateLabel,
} from "@/lib/pr/pr-detail-projection";
import {
  PR_TONE_CHIP_CLASS,
  PR_TONE_TEXT_CLASS,
  prReviewStateTone,
} from "@/components/epic-canvas/pr/pr-detail-tone";
import { PrActorAvatar } from "@/components/epic-canvas/pr/pr-detail-avatar";
import { TraycerMarkdown } from "@/markdown/traycer-markdown";
import { useRelativeTimestamp } from "@/lib/relative-time";
import { cn } from "@/lib/utils";

/**
 * Conversation surfaces: the description and the Feedback feed.
 *
 * The shape here is a STACK OF CARDS, not GitHub's timeline. GitHub threads
 * every entry onto a 2px connector line through an avatar gutter, which buys
 * one thing - a visual claim that these events are one continuous sequence -
 * and costs a fixed 2.75rem indent on every row plus an avatar-sized column of
 * whitespace down the whole page. We do not need the claim: the entries are
 * already in order, and the feed is a triage inbox rather than a negotiation
 * transcript. Dropping the line returns the full column width to the text and
 * lets each entry be a self-contained card in the same language as the rest of
 * the app.
 */

const REVIEW_EVENT: Record<
  PrReviewState,
  { readonly sentence: string; readonly Icon: LucideIcon }
> = {
  approved: { sentence: "approved these changes", Icon: Check },
  changes_requested: { sentence: "requested changes", Icon: X },
  commented: { sentence: "reviewed", Icon: Eye },
  dismissed: { sentence: "dismissed a review", Icon: X },
  pending: { sentence: "started a review", Icon: Clock },
};

export function PrDetailDescriptionCard(props: {
  readonly core: PrDetailCore;
  readonly onQuote: (() => void) | null;
}): ReactNode {
  const body = props.core.body ?? "";
  return (
    <PrSurfaceCard
      tone="none"
      testId="pr-detail-description-section"
      header={
        <>
          <h2 className="min-w-0 flex-1 truncate text-ui-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Description
          </h2>
          <PrQuoteAction
            label="Quote the description into the selected chat"
            testId="pr-detail-description-quote"
            onQuote={props.onQuote}
          />
        </>
      }
    >
      <PrCardBody
        body={body}
        emptyBody="No description provided."
        density="card"
      />
    </PrSurfaceCard>
  );
}

/**
 * The Feedback tab: every comment and review body that has text, as cards,
 * with body-less review submissions folded into one-line events between them.
 */
export function PrDetailConversation(props: {
  readonly core: PrDetailCore;
  readonly activity: PrActivitySection;
  readonly reviewThreads: PrReviewThreadsSection;
  readonly onQuoteItem: ((item: PrActivityItem) => void) | null;
  readonly onQuoteThread: ((thread: PrReviewThread) => void) | null;
}): ReactNode {
  const { entries, orphanThreads } = groupPrConversation(
    props.activity.items,
    props.reviewThreads.threads,
  );
  if (entries.length === 0 && orphanThreads.length === 0) {
    return (
      <p
        className="rounded-xl border border-dashed border-border/60 py-10 text-center text-ui-sm text-muted-foreground/70"
        data-testid="pr-detail-conversation-empty"
      >
        No comments or reviews yet.
      </p>
    );
  }
  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      data-testid="pr-detail-conversation"
    >
      {entries.map((entry) => (
        <PrConversationRow
          key={entry.key}
          entry={entry}
          onQuoteItem={props.onQuoteItem}
          onQuoteThread={props.onQuoteThread}
        />
      ))}
      {orphanThreads.length > 0 ? (
        <PrOrphanThreads
          threads={orphanThreads}
          onQuoteThread={props.onQuoteThread}
        />
      ) : null}
      {props.activity.isTruncated && props.core.prUrl !== null ? (
        <PrOlderOnGitHub
          href={props.core.prUrl}
          label="View older activity on GitHub"
        />
      ) : null}
      {props.reviewThreads.isTruncated && props.core.prUrl !== null ? (
        <PrOlderOnGitHub
          href={props.core.prUrl}
          label="View the remaining inline comments on GitHub"
        />
      ) : null}
    </div>
  );
}

function PrConversationRow(props: {
  readonly entry: PrConversationEntry;
  readonly onQuoteItem: ((item: PrActivityItem) => void) | null;
  readonly onQuoteThread: ((thread: PrReviewThread) => void) | null;
}): ReactNode {
  if (props.entry.kind === "event") {
    return (
      <PrReviewEventRow item={props.entry.item} repeats={props.entry.repeats} />
    );
  }
  const { item, threads } = props.entry;
  const verdict = item.kind === "review" ? item.state : null;
  return (
    <PrSurfaceCard
      tone={verdict === null ? "none" : prReviewStateTone(verdict)}
      testId="pr-detail-activity-item"
      header={
        <>
          <PrActorAvatar actor={item.author} size="sm" className="shrink-0" />
          <span className="min-w-0 truncate font-medium text-foreground">
            {formatPrActorName(item.author)}
          </span>
          {verdict !== null ? (
            <span
              className={cn(
                "shrink-0 rounded-full border px-1.5 text-ui-xs",
                PR_TONE_CHIP_CLASS[prReviewStateTone(verdict)],
              )}
            >
              {formatPrReviewStateLabel(verdict)}
            </span>
          ) : null}
          <span className="flex-1" aria-hidden />
          <PrRelativeTime timestamp={item.createdAt} />
          <PrQuoteAction
            label={`Quote ${formatPrActorName(item.author)}'s ${item.kind} into the selected chat`}
            testId="pr-detail-activity-quote"
            onQuote={
              props.onQuoteItem === null
                ? null
                : () => {
                    props.onQuoteItem?.(item);
                  }
            }
          />
        </>
      }
    >
      {/* A review that posted findings but wrote no summary gets its findings
          and nothing else - "No content." beneath five real objections would
          be actively wrong. */}
      {item.body.trim().length > 0 || threads.length === 0 ? (
        <PrCardBody body={item.body} emptyBody="No content." density="card" />
      ) : null}
      {threads.length > 0 ? (
        <PrReviewThreadList
          threads={threads}
          onQuoteThread={props.onQuoteThread}
        />
      ) : null}
    </PrSurfaceCard>
  );
}

/**
 * A review's inline findings: open ones in full, resolved ones behind a count.
 *
 * The split is the tab's whole premise - Feedback answers "what is blocking
 * this" - but resolved threads stay one click away rather than vanishing,
 * because "was this already dealt with?" is the next question a reader asks.
 */
function PrReviewThreadList(props: {
  readonly threads: readonly PrReviewThread[];
  readonly onQuoteThread: ((thread: PrReviewThread) => void) | null;
}): ReactNode {
  const { open, resolved } = partitionThreadsByResolution(props.threads);
  return (
    <div
      className="mt-3 flex min-w-0 flex-col gap-2 border-t border-border/50 pt-3"
      data-testid="pr-detail-review-threads"
    >
      {open.map((thread) => (
        <PrReviewThreadCard
          key={thread.id}
          thread={thread}
          onQuoteThread={props.onQuoteThread}
        />
      ))}
      {resolved.length > 0 ? (
        <PrResolvedThreads
          threads={resolved}
          onQuoteThread={props.onQuoteThread}
        />
      ) : null}
    </div>
  );
}

/**
 * Resolved findings, mounted only once opened.
 *
 * `<details>` hides its children with CSS, so an uncontrolled one would still
 * mount every collapsed thread - and each thread now mounts a real diff
 * renderer that parses and highlights its hunk off the main thread. On a bot
 * pass with fifteen findings that is fifteen highlight jobs for panels nobody
 * has asked to see.
 */
function PrResolvedThreads(props: {
  readonly threads: readonly PrReviewThread[];
  readonly onQuoteThread: ((thread: PrReviewThread) => void) | null;
}): ReactNode {
  const [isOpen, setIsOpen] = useState(false);
  const handleToggle = useCallback(
    (event: SyntheticEvent<HTMLDetailsElement>): void => {
      setIsOpen(event.currentTarget.open);
    },
    [],
  );
  return (
    <details
      className="min-w-0"
      data-testid="pr-detail-resolved-threads"
      onToggle={handleToggle}
    >
      <summary className="cursor-pointer list-none text-ui-xs text-muted-foreground/70 transition-colors hover:text-foreground">
        {props.threads.length} resolved
      </summary>
      {isOpen ? (
        <div className="mt-2 flex min-w-0 flex-col gap-2">
          {props.threads.map((thread) => (
            <PrReviewThreadCard
              key={thread.id}
              thread={thread}
              onQuoteThread={props.onQuoteThread}
            />
          ))}
        </div>
      ) : null}
    </details>
  );
}

/** One finding: where it points, the hunk it points at, and the discussion. */
function PrReviewThreadCard(props: {
  readonly thread: PrReviewThread;
  readonly onQuoteThread: ((thread: PrReviewThread) => void) | null;
}): ReactNode {
  const { thread } = props;
  const anchor = prReviewThreadAnchor(thread);
  const hidden = thread.totalCommentCount - thread.comments.length;
  return (
    <div
      className={cn(
        "min-w-0 rounded-lg border border-border/60 bg-muted/20",
        thread.isResolved && "opacity-70",
      )}
      data-testid="pr-detail-review-thread"
      data-resolved={thread.isResolved}
    >
      <div className="group/header flex min-w-0 items-center gap-2 border-b border-border/50 px-2.5 py-1.5">
        <FileCode
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <StartTruncatedText className="min-w-0 flex-1 font-mono text-ui-xs text-foreground">
          {anchor.label}
        </StartTruncatedText>
        {thread.isOutdated ? (
          <TooltipWrapper
            label={
              anchor.isOriginal
                ? "The line this points at has moved or gone; showing its position in the reviewed commit."
                : "This thread refers to an earlier version of the file."
            }
            side="top"
            sideOffset={6}
            align="center"
          >
            <span className="shrink-0 rounded-full border border-transparent bg-muted/60 px-1.5 text-ui-xs text-muted-foreground">
              Outdated
            </span>
          </TooltipWrapper>
        ) : null}
        {thread.isResolved ? (
          <span className="shrink-0 rounded-full border border-transparent bg-muted/60 px-1.5 text-ui-xs text-muted-foreground">
            Resolved
          </span>
        ) : null}
        <PrQuoteAction
          label={`Quote the inline comment on ${anchor.label} into the selected chat`}
          testId="pr-detail-thread-quote"
          onQuote={
            props.onQuoteThread === null
              ? null
              : () => {
                  props.onQuoteThread?.(thread);
                }
          }
        />
      </div>
      <PrReviewThreadHunk thread={thread} />
      <div className="flex min-w-0 flex-col divide-y divide-border/40">
        {thread.comments.map((comment) => (
          <div key={comment.id} className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5 px-2.5 pt-2 text-ui-xs text-muted-foreground">
              <PrActorAvatar
                actor={comment.author}
                size="sm"
                className="shrink-0"
              />
              <span className="min-w-0 truncate font-medium text-foreground">
                {formatPrActorName(comment.author)}
              </span>
              <span className="flex-1" aria-hidden />
              <PrRelativeTime timestamp={comment.createdAt} />
            </div>
            <PrCardBody
              body={comment.body}
              emptyBody="No content."
              density="inline"
            />
          </div>
        ))}
        {hidden > 0 ? (
          <p className="px-2.5 py-1.5 text-ui-xs text-muted-foreground/70">
            {hidden} more {hidden === 1 ? "reply" : "replies"} on GitHub.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The lines a finding points at, through the app's own diff renderer.
 *
 * This used to be a `<pre>` of the raw hunk: no gutter, one flat colour for
 * added, removed, and context alike, so the reader had to decode `+`/`-`
 * prefixes by eye to see what the comment was even about. It is a diff, and
 * every other diff in the app is rendered by the same pipeline - reusing it
 * costs one adapter and buys tones, syntax highlighting, and line numbers that
 * agree with the file.
 */
function PrReviewThreadHunk(props: {
  readonly thread: PrReviewThread;
}): ReactNode {
  const { thread } = props;
  const hunk = useMemo(() => buildPrReviewHunkPatch(thread), [thread]);
  if (hunk === null) return null;
  return (
    <div
      className="min-w-0 border-b border-border/50 bg-card"
      data-testid="pr-detail-thread-hunk"
      data-line-numbers={hunk.lineNumbers}
    >
      <DiffContentFrame
        sizing="content"
        banner={null}
        scrollContainerRef={null}
        onScroll={null}
      >
        <DiffContentPrimitive
          patch={hunk.patch}
          cacheScope={`pr-review-thread:${thread.id}`}
          mode="unified"
          wordWrap
          backgrounds
          lineNumbers={hunk.lineNumbers}
          indicatorStyle="bars"
          fileHeaders={false}
        />
      </DiffContentFrame>
    </div>
  );
}

/**
 * Findings whose review is not in this frame - it fell out of the review
 * window, or the cached fact predates review ids. Grouped rather than dropped:
 * an unresolved finding is exactly what this tab is for.
 */
function PrOrphanThreads(props: {
  readonly threads: readonly PrReviewThread[];
  readonly onQuoteThread: ((thread: PrReviewThread) => void) | null;
}): ReactNode {
  return (
    <PrSurfaceCard
      tone="none"
      testId="pr-detail-orphan-threads"
      header={
        <span className="min-w-0 truncate font-medium text-foreground">
          Inline comments
        </span>
      }
    >
      <PrReviewThreadList
        threads={props.threads}
        onQuoteThread={props.onQuoteThread}
      />
    </PrSurfaceCard>
  );
}

/** A review that left no text: one line, never a card. */
function PrReviewEventRow(props: {
  readonly item: PrReviewActivityItem;
  readonly repeats: number;
}): ReactNode {
  const event = REVIEW_EVENT[props.item.state];
  const tone = prReviewStateTone(props.item.state);
  return (
    <div
      className="flex min-w-0 items-center gap-2 px-1 text-ui-xs text-muted-foreground"
      data-testid="pr-detail-activity-event"
      data-repeats={props.repeats}
    >
      <event.Icon
        className={cn("size-3.5 shrink-0", PR_TONE_TEXT_CLASS[tone])}
        aria-hidden
      />
      <PrActorAvatar actor={props.item.author} size="sm" className="shrink-0" />
      <span className="min-w-0 truncate">
        <span className="font-medium text-foreground">
          {formatPrActorName(props.item.author)}
        </span>{" "}
        {event.sentence}
        {props.repeats > 1 ? ` · ${props.repeats}×` : ""}
      </span>
      <span className="flex-1" aria-hidden />
      <PrRelativeTime timestamp={props.item.createdAt} />
    </div>
  );
}

/**
 * The one card shell every conversation surface uses: a muted header rail and
 * a body. `tone` tints only the border, so an approval or an objection is
 * legible at a glance without the body becoming a coloured panel.
 */
function PrSurfaceCard(props: {
  readonly tone: "ok" | "fail" | "pending" | "none";
  readonly testId: string;
  readonly header: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section
      data-testid={props.testId}
      className={cn(
        "min-w-0 overflow-hidden rounded-xl border bg-canvas",
        props.tone === "ok" && "border-success/25",
        props.tone === "fail" && "border-destructive/30",
        props.tone === "pending" && "border-warning/25",
        props.tone === "none" && "border-border/60",
      )}
    >
      <div className="group/header flex min-w-0 items-center gap-2 border-b border-border/50 bg-muted/25 px-3 py-2 text-ui-xs text-muted-foreground">
        {props.header}
      </div>
      {props.children}
    </section>
  );
}

/**
 * `density` is the difference between a card that owns its column and a body
 * nested two borders deep inside one. The nested case has to line up with a
 * 2.5-unit header rail above it; card padding there reads as a text block that
 * drifted right of everything around it.
 */
function PrCardBody(props: {
  readonly body: string;
  readonly emptyBody: string;
  readonly density: "card" | "inline";
}): ReactNode {
  return (
    <div
      className={cn(
        "min-w-0",
        props.density === "card" ? "px-4 py-3.5" : "px-2.5 pt-1.5 pb-2",
      )}
    >
      {props.body.trim().length === 0 ? (
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
  );
}

/**
 * Hover-revealed on pointer, always present for keyboard and screen readers.
 * `null` means no chat is selected to send to, which disables rather than
 * hides it - a missing button reads as "this cannot be quoted".
 */
function PrQuoteAction(props: {
  readonly label: string;
  readonly testId: string;
  readonly onQuote: (() => void) | null;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={props.onQuote ?? undefined}
      disabled={props.onQuote === null}
      aria-label={props.label}
      data-testid={props.testId}
      className={cn(
        "shrink-0 rounded p-1 text-muted-foreground/0 transition-colors",
        "group-hover/header:text-muted-foreground hover:text-foreground",
        "focus-visible:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
        "disabled:pointer-events-none disabled:opacity-50",
      )}
    >
      <TextQuote className="size-3.5" aria-hidden />
    </button>
  );
}

/**
 * "…and N older on GitHub" - the escape hatch out of a truncated section.
 * Routed through {@link PrExternalGitHubLink} like every other GitHub anchor
 * on these surfaces.
 */
export function PrOlderOnGitHub(props: {
  readonly href: string;
  readonly label: string;
}): ReactNode {
  return (
    <PrExternalGitHubLink
      href={props.href}
      className="self-start px-1 text-ui-xs text-primary hover:underline"
      testId="pr-older-on-github"
    >
      {props.label}
    </PrExternalGitHubLink>
  );
}

/**
 * A timestamp carries its own type treatment.
 *
 * It used to inherit, which meant every call site had to remember to size and
 * mute it - and the one that forgot rendered a comment's date at body size in
 * body colour, so the same "9 Jul" appeared twice in one card at two sizes.
 * A date is metadata wherever it appears here, so it looks like metadata
 * wherever it appears.
 */
export function PrRelativeTime(props: {
  readonly timestamp: number;
}): ReactNode {
  const label = useRelativeTimestamp(props.timestamp);
  return (
    <span
      className="shrink-0 text-ui-xs whitespace-nowrap text-muted-foreground"
      data-testid="pr-relative-time"
    >
      {label}
    </span>
  );
}
