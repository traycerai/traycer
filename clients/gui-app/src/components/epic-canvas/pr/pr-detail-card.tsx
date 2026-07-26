import { type ReactNode } from "react";
import { Check, Clock, Eye, TextQuote, X } from "lucide-react";
import type {
  PrActivitySection,
  PrDetailCore,
} from "@traycer/protocol/host/pr-schemas";
import type {
  PrAttentionQueue,
  PrCheckCounts,
} from "@/lib/pr/pr-attention-queue";
import type { PrQuoteTarget } from "@/lib/pr/pr-quote";
import {
  prReviewerRows,
  type PrReviewerState,
} from "@/lib/pr/pr-detail-projection";
import { PrActorAvatar } from "@/components/epic-canvas/pr/pr-detail-avatar";
import {
  formatPrChecksValue,
  PR_TONE_FILL_CLASS,
  PR_TONE_TEXT_CLASS,
  prChecksTone,
  prReviewDecisionTone,
} from "@/components/epic-canvas/pr/pr-detail-tone";
import { PrQuoteTargetPicker } from "@/components/epic-canvas/pr/pr-quote-target-picker";
import { cn } from "@/lib/utils";

const REVIEWER_STATE: Record<
  PrReviewerState,
  {
    readonly Icon: typeof Check;
    readonly className: string;
    readonly label: string;
  }
> = {
  requested: {
    Icon: Clock,
    className: "text-muted-foreground/70",
    label: "Review requested",
  },
  approved: {
    Icon: Check,
    className: PR_TONE_TEXT_CLASS.ok,
    label: "Approved",
  },
  changes_requested: {
    Icon: X,
    className: PR_TONE_TEXT_CLASS.fail,
    label: "Requested changes",
  },
  commented: {
    Icon: Eye,
    className: "text-muted-foreground",
    label: "Reviewed",
  },
  dismissed: {
    Icon: Eye,
    className: "text-muted-foreground/70",
    label: "Review dismissed",
  },
  pending: {
    Icon: Clock,
    className: "text-muted-foreground/70",
    label: "Review pending",
  },
};

const REVIEW_DECISION_LABEL = {
  approved: "Approved",
  changes_requested: "Changes req.",
  review_required: "Review required",
} as const;

export interface PrDetailCardProps {
  readonly core: PrDetailCore;
  readonly activity: PrActivitySection;
  readonly queue: PrAttentionQueue;
  readonly target: PrQuoteTarget | null;
  readonly targets: readonly PrQuoteTarget[];
  readonly onSelectTarget: (target: PrQuoteTarget) => void;
  readonly onSendPr: () => void;
  readonly className: string | undefined;
}

/**
 * The context card: the second column of the detail shell's row, sticky as the
 * document scrolls.
 *
 * It carries ONLY what exists nowhere else - the proportional check meter, the
 * review decision, per-reviewer state, and the send action. State, branches,
 * diffstat and freshness all used to be here too, and all four are in the
 * header, in full, with more room. That duplication is what made the card feel
 * cramped at any width: it was spending its space restating the page.
 *
 * Below the container-width threshold the card is simply absent, and nothing
 * takes its place. Checks reach the reader through the tab badge and the Checks
 * tab, reviewers through Feedback, and the send target defaults to the PR's own
 * owner chat - so its absence costs convenience, never capability.
 */
export function PrDetailCard(props: PrDetailCardProps): ReactNode {
  const reviewers = prReviewerRows(props.core, props.activity);
  return (
    <div
      data-testid="pr-detail-card"
      className={cn(
        "flex min-w-0 flex-col rounded-xl border border-border/70 bg-canvas p-3 text-ui-xs shadow-lg",
        props.className,
      )}
    >
      {/* No state row, no branches, no diffstat, no "updated" - the header
          carries all four, in full and with more room for them. A card beside
          the thing it repeats is worse than no card: it doubles the reading
          without adding a fact, and it was what made 280px feel cramped. What
          is left is what exists ONLY here: the proportional check meter, the
          review decision, per-reviewer state, and the send action. */}
      <PrCardSection heading="Health">
        <PrCardHealth core={props.core} counts={props.queue.checkCounts} />
      </PrCardSection>
      <PrCardSection heading="Reviewers">
        {reviewers.length === 0 ? (
          <p className="text-muted-foreground/70">
            {props.activity.isTruncated || props.core.reviewDecision !== null
              ? "See GitHub for review history"
              : "No reviews"}
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {reviewers.map((reviewer) => {
              const state = REVIEWER_STATE[reviewer.state];
              return (
                <li
                  key={reviewer.actor.login}
                  className="flex min-w-0 items-center gap-2"
                >
                  <PrActorAvatar
                    actor={reviewer.actor}
                    size="sm"
                    className={undefined}
                  />
                  <span className="min-w-0 flex-1 truncate text-foreground">
                    {reviewer.actor.login}
                  </span>
                  <state.Icon
                    className={cn("size-3.5 shrink-0", state.className)}
                    aria-label={state.label}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </PrCardSection>
      {/* The picker lives WITH the send action, not in the header. In the
          header it read as a stray dropdown on the title line answering a
          question nobody had asked; here it is plainly "which chat does this
          button send to". The header instead shows the PR's linked chats as
          the same clickable pills the panel row uses - that answers "which
          conversation produced this?", which is what a reader actually wants
          from a header. */}
      <PrCardSection heading="Send to chat">
        <PrQuoteTargetPicker
          target={props.target}
          targets={props.targets}
          onSelectTarget={props.onSelectTarget}
          variant="card"
        />
        <button
          type="button"
          onClick={props.onSendPr}
          disabled={props.target === null}
          data-testid="pr-detail-send-pr"
          className={cn(
            "mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-primary/35 bg-primary/10 px-2 py-1.5",
            "text-ui-xs text-primary transition-colors hover:bg-primary/15",
            "disabled:opacity-50",
          )}
        >
          <TextQuote className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">
            {props.target === null
              ? "No chat to send to"
              : `Send PR to “${props.target.title}”`}
          </span>
        </button>
      </PrCardSection>
    </div>
  );
}

function PrCardHealth(props: {
  readonly core: PrDetailCore;
  readonly counts: PrCheckCounts;
}): ReactNode {
  const { counts } = props;
  const checksTone = prChecksTone(counts);
  return (
    <div className="flex flex-col gap-1">
      <PrCardGauge
        label="Checks"
        value={formatPrChecksValue(counts)}
        valueClassName={PR_TONE_TEXT_CLASS[checksTone]}
      />
      {counts.total > 0 ? <PrHealthMeter counts={counts} /> : null}
      {props.core.reviewDecision !== null ? (
        <PrCardGauge
          label="Review"
          value={REVIEW_DECISION_LABEL[props.core.reviewDecision]}
          valueClassName={
            PR_TONE_TEXT_CLASS[prReviewDecisionTone(props.core.reviewDecision)]
          }
        />
      ) : null}
    </div>
  );
}

function PrCardGauge(props: {
  readonly label: string;
  readonly value: ReactNode;
  readonly valueClassName: string | undefined;
}): ReactNode {
  return (
    <div className="flex min-w-0 items-center gap-2 py-0.5">
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {props.label}
      </span>
      <span className={cn("shrink-0 text-foreground", props.valueClassName)}>
        {props.value}
      </span>
    </div>
  );
}

/**
 * Proportional check meter. Segments are flex-weighted by count rather than a
 * fixed number of ticks, so a 2-of-200 failure still reads as a thin red sliver
 * instead of being rounded away to nothing or exaggerated to a tenth of the bar.
 */
function PrHealthMeter(props: { readonly counts: PrCheckCounts }): ReactNode {
  const { failing, pending, passed, total } = props.counts;
  const other = Math.max(0, total - failing - pending - passed);
  const segments = [
    { tone: "fail", weight: failing },
    { tone: "pending", weight: pending },
    { tone: "ok", weight: passed },
    { tone: "none", weight: other },
  ] as const;
  return (
    <div
      className="mb-1 flex h-1 w-full gap-0.5 overflow-hidden rounded-full"
      data-testid="pr-detail-health-meter"
      aria-hidden
    >
      {segments
        .filter((segment) => segment.weight > 0)
        .map((segment) => (
          <span
            key={segment.tone}
            style={{ flexGrow: segment.weight }}
            className={cn("rounded-full", PR_TONE_FILL_CLASS[segment.tone])}
          />
        ))}
    </div>
  );
}

function PrCardSection(props: {
  readonly heading: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section className="border-b border-border/50 py-2.5 last:border-b-0 last:pb-0">
      <h3 className="mb-1.5 text-ui-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {props.heading}
      </h3>
      {props.children}
    </section>
  );
}
