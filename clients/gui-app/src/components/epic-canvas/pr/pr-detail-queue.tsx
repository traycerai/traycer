import { useCallback, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  Eye,
  Info,
  TextQuote,
  X,
  type LucideIcon,
} from "lucide-react";
import type {
  PrAttentionItem,
  PrAttentionQueue,
} from "@/lib/pr/pr-attention-queue";
import {
  formatPrAttentionHeadline,
  formatPrAttentionSubline,
  prAttentionRowText,
} from "@/lib/pr/pr-attention-queue";
import type { PrQuoteTarget } from "@/lib/pr/pr-quote";
import {
  PR_TONE_SURFACE_CLASS,
  PR_TONE_TEXT_CLASS,
} from "@/components/epic-canvas/pr/pr-detail-tone";
import { PrActorAvatar } from "@/components/epic-canvas/pr/pr-detail-avatar";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
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
      <div
        className={cn(
          "flex min-w-0 items-center gap-2 px-3 py-2",
          !isCalm && "border-b border-border/40",
        )}
      >
        <span
          className={cn(
            "inline-flex size-5 shrink-0 items-center justify-center rounded-full",
            isCalm ? "bg-success/15" : "bg-destructive/15",
          )}
          aria-hidden
        >
          {isCalm ? (
            <Check className={cn("size-3", PR_TONE_TEXT_CLASS.ok)} />
          ) : (
            <AlertTriangle className={cn("size-3", PR_TONE_TEXT_CLASS.fail)} />
          )}
        </span>
        <h2 className="shrink-0 text-ui-sm font-medium text-foreground">
          {formatPrAttentionHeadline(props.queue)}
        </h2>
        {subline !== null ? (
          <p className="min-w-0 truncate text-ui-xs text-muted-foreground/80">
            {subline}
          </p>
        ) : null}
        <span className="flex-1" aria-hidden />
        {props.queue.isWindowTruncated ? <PrQueueWindowNote /> : null}
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
    </section>
  );
}

/**
 * The caveat on the queue's own completeness, as an icon rather than a line.
 *
 * It used to be a full-width warning-toned row at the foot of the card, which
 * made the least urgent thing on the page the brightest: the eye landed on a
 * caveat about the derivation before it reached the thing that actually needs
 * a decision. The fact still has to be reachable - a queue derived from a
 * capped window can be wrong by omission - but it belongs where a reader goes
 * looking for provenance, not in their way.
 */
const QUEUE_WINDOW_NOTE =
  "Derived from the last 20 activity items and first 50 checks — older feedback may exist on GitHub.";

function PrQueueWindowNote(): ReactNode {
  return (
    <TooltipWrapper
      label={QUEUE_WINDOW_NOTE}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span
        className="inline-flex shrink-0 items-center text-muted-foreground/60 transition-colors hover:text-muted-foreground"
        data-testid="pr-detail-queue-truncated"
        aria-label={QUEUE_WINDOW_NOTE}
        role="img"
      >
        <Info className="size-3.5 shrink-0" aria-hidden />
      </span>
    </TooltipWrapper>
  );
}

/**
 * The row's one identity slot, in order of how much it actually identifies:
 * the person or bot behind it, then the app that reported it, then the kind's
 * own mark as a last resort. A check has no actor but is very much
 * attributable, and the generic glyph threw that away.
 */
function PrQueueRowMark(props: {
  readonly item: PrAttentionItem;
  readonly tone: "fail" | "pending";
  readonly Glyph: LucideIcon;
}): ReactNode {
  const { item } = props;
  if (item.actor !== null) {
    return <PrActorAvatar actor={item.actor} size="sm" className={undefined} />;
  }
  if (item.iconUrl !== null) {
    return (
      <img
        src={item.iconUrl}
        alt=""
        aria-hidden
        loading="lazy"
        data-testid="pr-detail-queue-app-mark"
        className="size-5 rounded-sm bg-muted/40 object-contain"
      />
    );
  }
  return (
    <span
      className={cn(
        "inline-flex size-6 items-center justify-center rounded-full",
        props.tone === "fail" ? "bg-destructive/12" : "bg-warning/12",
      )}
      aria-hidden
    >
      <props.Glyph className={cn("size-3.5", PR_TONE_TEXT_CLASS[props.tone])} />
    </span>
  );
}

function PrQueueRow(props: {
  readonly item: PrAttentionItem;
  readonly target: PrQuoteTarget | null;
  readonly onSendItem: (item: PrAttentionItem) => void;
  readonly onOpenDetails: (url: string) => void;
}): ReactNode {
  const { item, onOpenDetails } = props;
  const Glyph = KIND_GLYPH[item.kind];
  const tone = item.kind === "review-required" ? "pending" : "fail";
  const text = prAttentionRowText(item);
  const openDetails = useCallback((): void => {
    if (item.detailsUrl !== null) onOpenDetails(item.detailsUrl);
  }, [item.detailsUrl, onOpenDetails]);
  return (
    <div
      className="flex min-w-0 items-center gap-3 px-3 py-2.5 transition-colors not-first:border-t not-first:border-border/30 hover:bg-foreground/[0.02]"
      data-testid="pr-detail-queue-row"
      data-kind={item.kind}
    >
      {/* One glyph slot, whatever the source: an avatar when a person or bot
          is behind it, the kind's own mark otherwise. Keeping the slot a fixed
          size is what lets several rows read as a column rather than a list of
          differently-indented paragraphs. */}
      <span className="inline-flex size-6 shrink-0 items-center justify-center">
        <PrQueueRowMark item={item} tone={tone} Glyph={Glyph} />
      </span>

      <div className="min-w-0 flex-1">
        {/* The HEADLINE is what needs doing, not who said it. A check leads
            with its name, a review with its finding. */}
        {/* The name IS the link, as on the Checks tab: the row's subject is
            the thing a reader wants to open, so it should not need a separate
            target beside it. No url means plain text, never a dead control. */}
        {item.detailsUrl === null ? (
          <TooltipWrapper
            label={text.headline}
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            <p
              className={cn(
                "min-w-0 truncate text-ui-sm text-foreground",
                text.isIdentifier && "font-mono",
              )}
              data-testid="pr-detail-queue-headline"
            >
              {text.headline}
            </p>
          </TooltipWrapper>
        ) : (
          <TooltipWrapper
            label={text.headline}
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            <button
              type="button"
              onClick={openDetails}
              data-testid="pr-detail-queue-headline"
              className={cn(
                "block min-w-0 max-w-full truncate text-left text-ui-sm text-foreground",
                "transition-colors hover:text-primary hover:underline",
                "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
                text.isIdentifier && "font-mono",
              )}
            >
              {text.headline}
            </button>
          </TooltipWrapper>
        )}
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-ui-xs text-muted-foreground/70">
          <span className="shrink-0">{KIND_SOURCE_LABEL[item.kind]}</span>
          {text.meta !== null ? (
            <>
              <span aria-hidden>·</span>
              <span className="min-w-0 truncate">{text.meta}</span>
            </>
          ) : null}
        </div>
      </div>

      <button
        type="button"
        onClick={() => props.onSendItem(item)}
        disabled={props.target === null}
        data-testid="pr-detail-queue-send"
        aria-label={
          props.target === null
            ? "Choose a chat to send to first"
            : `Send \u201c${text.headline}\u201d to ${props.target.title}`
        }
        // Deliberately NOT hover-revealed. Routing a finding into the agent
        // that wrote the branch is the one thing this view does that GitHub
        // cannot; hiding it until the pointer lands would make the whole
        // differentiator invisible to anyone who did not think to look.
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-ui-xs",
          "border-border/60 text-muted-foreground transition-colors",
          "hover:border-primary/40 hover:bg-primary/10 hover:text-primary",
          "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
          "disabled:opacity-40 disabled:hover:border-border/60 disabled:hover:bg-transparent disabled:hover:text-muted-foreground",
        )}
      >
        <TextQuote className="size-3 shrink-0" aria-hidden />
        Fix in chat
      </button>
    </div>
  );
}
