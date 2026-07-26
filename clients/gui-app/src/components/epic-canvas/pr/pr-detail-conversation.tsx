import { type ReactNode } from "react";
import { Check, Clock, Eye, TextQuote, X, type LucideIcon } from "lucide-react";
import type {
  PrActivityItem,
  PrActivitySection,
  PrDetailCore,
  PrReviewState,
} from "@traycer/protocol/host/pr-schemas";
import {
  groupPrConversation,
  type PrConversationEntry,
  type PrReviewActivityItem,
} from "@/lib/pr/pr-conversation";
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
      <PrCardBody body={body} emptyBody="No description provided." />
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
  readonly onQuoteItem: ((item: PrActivityItem) => void) | null;
}): ReactNode {
  const entries = groupPrConversation(props.activity.items);
  if (entries.length === 0) {
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
        />
      ))}
      {props.activity.isTruncated && props.core.prUrl !== null ? (
        <PrOlderOnGitHub
          href={props.core.prUrl}
          label="View older activity on GitHub"
        />
      ) : null}
    </div>
  );
}

function PrConversationRow(props: {
  readonly entry: PrConversationEntry;
  readonly onQuoteItem: ((item: PrActivityItem) => void) | null;
}): ReactNode {
  if (props.entry.kind === "event") {
    return (
      <PrReviewEventRow item={props.entry.item} repeats={props.entry.repeats} />
    );
  }
  const { item } = props.entry;
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
      <PrCardBody body={item.body} emptyBody="No content." />
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

function PrCardBody(props: {
  readonly body: string;
  readonly emptyBody: string;
}): ReactNode {
  return (
    <div className="min-w-0 px-4 py-3.5">
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

export function PrOlderOnGitHub(props: {
  readonly href: string;
  readonly label: string;
}): ReactNode {
  return (
    <a
      href={props.href}
      target="_blank"
      rel="noreferrer"
      className="self-start px-1 text-ui-xs text-primary hover:underline"
    >
      {props.label}
    </a>
  );
}

export function PrRelativeTime(props: {
  readonly timestamp: number;
}): ReactNode {
  const label = useRelativeTimestamp(props.timestamp);
  return <span className="shrink-0 whitespace-nowrap">{label}</span>;
}
