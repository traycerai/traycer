import { type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  Eye,
  ExternalLink,
  TextQuote,
  X,
} from "lucide-react";
import type {
  PrAttentionItem,
  PrAttentionQueue,
} from "@/lib/pr/pr-attention-queue";
import {
  formatPrAttentionHeadline,
  formatPrAttentionSubline,
} from "@/lib/pr/pr-attention-queue";
import type { PrQuoteTarget } from "@/lib/pr/pr-quote";
import {
  PR_TONE_SURFACE_CLASS,
  PR_TONE_TEXT_CLASS,
} from "@/components/epic-canvas/pr/pr-detail-tone";
import { PrActorAvatar } from "@/components/epic-canvas/pr/pr-detail-avatar";
import { cn } from "@/lib/utils";

const KIND_GLYPH = {
  "check-failure": X,
  "changes-requested": AlertTriangle,
  "review-required": Eye,
} as const;

const KIND_SOURCE_LABEL = {
  "check-failure": "check",
  "changes-requested": "review",
  "review-required": "review",
} as const;

/**
 * The Overview tab's hero: what needs a decision, each row routable to an agent.
 *
 * The calm state is a DESIGNED state, not an empty one. An attention queue that
 * renders as a blank box when a PR is green would make the most common healthy
 * outcome feel like a failure to load, so zero items produces an affirmative
 * "Nothing blocking" with the evidence that backs it.
 */
export function PrDetailQueue(props: {
  readonly queue: PrAttentionQueue;
  readonly target: PrQuoteTarget | null;
  readonly onSendItem: (item: PrAttentionItem) => void;
  readonly onOpenDetails: (url: string) => void;
}): ReactNode {
  const isCalm = props.queue.items.length === 0;
  const subline = formatPrAttentionSubline(props.queue);
  return (
    <section
      data-testid="pr-detail-queue"
      data-calm={isCalm ? "true" : "false"}
      className={cn(
        "overflow-hidden rounded-xl border",
        isCalm ? PR_TONE_SURFACE_CLASS.ok : PR_TONE_SURFACE_CLASS.fail,
      )}
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 px-3 py-2.5">
        {isCalm ? (
          <Check
            className={cn("size-4 shrink-0 self-center", PR_TONE_TEXT_CLASS.ok)}
            aria-hidden
          />
        ) : null}
        <h2 className="text-ui-sm font-medium text-foreground">
          {formatPrAttentionHeadline(props.queue)}
        </h2>
        {subline !== null ? (
          <p className="min-w-0 text-ui-xs text-muted-foreground">
            · {subline}
          </p>
        ) : null}
      </div>
      {props.queue.items.map((item) => (
        <PrQueueRow
          key={item.key}
          item={item}
          target={props.target}
          onSendItem={props.onSendItem}
          onOpenDetails={props.onOpenDetails}
        />
      ))}
      {!isCalm && props.queue.isWindowTruncated ? (
        <p
          className={cn(
            "border-t border-border/50 px-3 py-1.5 text-ui-xs",
            PR_TONE_TEXT_CLASS.pending,
          )}
          data-testid="pr-detail-queue-truncated"
        >
          Derived from the last 20 activity items and first 50 checks — older
          feedback may exist on GitHub.
        </p>
      ) : null}
    </section>
  );
}

function PrQueueRow(props: {
  readonly item: PrAttentionItem;
  readonly target: PrQuoteTarget | null;
  readonly onSendItem: (item: PrAttentionItem) => void;
  readonly onOpenDetails: (url: string) => void;
}): ReactNode {
  const Glyph = KIND_GLYPH[props.item.kind];
  const tone = props.item.kind === "review-required" ? "pending" : "fail";
  return (
    <div
      className="flex min-w-0 items-start gap-2.5 border-t border-border/50 px-3 py-2"
      data-testid="pr-detail-queue-row"
      data-kind={props.item.kind}
    >
      {props.item.actor !== null ? (
        <PrActorAvatar
          actor={props.item.actor}
          size="sm"
          className="mt-0.5 shrink-0"
        />
      ) : (
        <Glyph
          className={cn("mt-0.5 size-3.5 shrink-0", PR_TONE_TEXT_CLASS[tone])}
          aria-hidden
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span
            className={cn(
              "min-w-0 text-ui-sm text-foreground",
              props.item.kind === "check-failure" && "font-mono",
            )}
          >
            {props.item.title}
          </span>
          <span className="shrink-0 rounded border border-border/60 px-1 text-ui-xs text-muted-foreground/70">
            {KIND_SOURCE_LABEL[props.item.kind]}
          </span>
        </div>
        {props.item.detail !== null ? (
          <p className="mt-0.5 line-clamp-2 text-ui-xs break-words text-muted-foreground">
            {props.item.detail}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => props.onSendItem(props.item)}
          disabled={props.target === null}
          data-testid="pr-detail-queue-send"
          aria-label={
            props.target === null
              ? "Choose a chat to send to first"
              : `Send “${props.item.title}” to ${props.target.title}`
          }
          className={cn(
            "inline-flex items-center gap-1 rounded-md border border-primary/35 bg-primary/10 px-2 py-1",
            "text-ui-xs text-primary transition-colors hover:bg-primary/15 disabled:opacity-50",
          )}
        >
          <TextQuote className="size-3 shrink-0" aria-hidden />
          Fix in chat
        </button>
        {props.item.detailsUrl !== null ? (
          <PrQueueDetailsLink
            url={props.item.detailsUrl}
            onOpenDetails={props.onOpenDetails}
          />
        ) : null}
      </div>
    </div>
  );
}

function PrQueueDetailsLink(props: {
  readonly url: string;
  readonly onOpenDetails: (url: string) => void;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={() => props.onOpenDetails(props.url)}
      aria-label="Open on GitHub"
      data-testid="pr-detail-queue-details"
      className="inline-flex items-center rounded-md border border-border/60 px-1.5 py-1 text-muted-foreground transition-colors hover:text-foreground"
    >
      <ExternalLink className="size-3" aria-hidden />
    </button>
  );
}
