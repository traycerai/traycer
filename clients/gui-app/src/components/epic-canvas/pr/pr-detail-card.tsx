import { type ReactNode } from "react";
import { Check, Clock, Eye, TextQuote, X } from "lucide-react";
import type {
  PrActivitySection,
  PrChecksSection,
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
  PR_DIFF_ADDED_CLASS,
  PR_DIFF_REMOVED_CLASS,
  PR_TONE_FILL_CLASS,
  PR_TONE_TEXT_CLASS,
  prChecksTone,
  prReviewDecisionTone,
  prStateTone,
} from "@/components/epic-canvas/pr/pr-detail-tone";
import { PrQuoteTargetPicker } from "@/components/epic-canvas/pr/pr-quote-target-picker";
import { useRelativeTimestamp } from "@/lib/relative-time";
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
  readonly checks: PrChecksSection;
  readonly activity: PrActivitySection;
  readonly queue: PrAttentionQueue;
  readonly target: PrQuoteTarget | null;
  readonly targets: readonly PrQuoteTarget[];
  readonly onSelectTarget: (target: PrQuoteTarget) => void;
  readonly onSendPr: () => void;
  readonly className: string | undefined;
}

/**
 * The context card that floats in the reading column's right gutter.
 *
 * It OVERLAYS dead space rather than reserving a band: a measure-limited
 * column centred in a wide tile already leaves the gutter empty, so the
 * column renders identically whether the card is present or not and toggling
 * it costs no reflow. Because it only exists above the container-width
 * threshold, nothing may live ONLY here - every fact it carries also reaches
 * the reader through `PrDetailSummaryStrip` at narrower widths.
 */
export function PrDetailCard(props: PrDetailCardProps): ReactNode {
  const reviewers = prReviewerRows(props.core, props.activity);
  return (
    <aside
      data-testid="pr-detail-card"
      className={cn(
        "flex min-w-0 flex-col rounded-xl border border-border/70 bg-canvas p-3 text-ui-xs shadow-lg",
        props.className,
      )}
    >
      <PrCardStateRow core={props.core} />
      <PrCardSection heading="Health">
        <PrCardHealth
          core={props.core}
          checks={props.checks}
          counts={props.queue.checkCounts}
        />
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
      <PrCardSection heading="Linked chats · send to">
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
    </aside>
  );
}

function PrCardStateRow(props: { readonly core: PrDetailCore }): ReactNode {
  const isDraft = props.core.state === "open" && props.core.isDraft === true;
  const tone = prStateTone(props.core);
  return (
    <div className="flex min-w-0 flex-col gap-2 border-b border-border/60 pb-2.5">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            PR_TONE_FILL_CLASS[tone],
          )}
          aria-hidden
        />
        <span className="text-ui-sm font-medium text-foreground">
          {isDraft
            ? "Draft"
            : props.core.state.charAt(0).toUpperCase() +
              props.core.state.slice(1)}
        </span>
      </div>
      <p className="min-w-0 leading-relaxed text-muted-foreground">
        <code className="rounded bg-primary/10 px-1 py-0.5 font-mono break-all text-primary">
          {props.core.headRefName ?? "unknown"}
        </code>
        <br />→{" "}
        <code className="rounded bg-primary/10 px-1 py-0.5 font-mono break-all text-primary">
          {props.core.baseRefName ?? "unknown"}
        </code>
      </p>
    </div>
  );
}

function PrCardHealth(props: {
  readonly core: PrDetailCore;
  readonly checks: PrChecksSection;
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
      {props.core.additions !== null && props.core.deletions !== null ? (
        <PrCardGauge
          label="Diff"
          value={
            <span className="font-mono">
              <span className={PR_DIFF_ADDED_CLASS}>
                +{props.core.additions}
              </span>{" "}
              <span className={PR_DIFF_REMOVED_CLASS}>
                −{props.core.deletions}
              </span>
            </span>
          }
          valueClassName={undefined}
        />
      ) : null}
      {props.checks.observedAt !== null ? (
        <PrCardUpdatedGauge observedAt={props.checks.observedAt} />
      ) : null}
    </div>
  );
}

function PrCardUpdatedGauge(props: { readonly observedAt: number }): ReactNode {
  const label = useRelativeTimestamp(props.observedAt);
  return (
    <PrCardGauge label="Updated" value={label} valueClassName={undefined} />
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
