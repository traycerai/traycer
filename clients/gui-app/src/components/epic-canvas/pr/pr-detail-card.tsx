import { type ReactNode } from "react";
import { Check, Clock, Eye, X } from "lucide-react";
import type {
  PrActivitySection,
  PrDetailCore,
} from "@traycer/protocol/host/pr-schemas";
import type {
  PrAttentionQueue,
  PrCheckCounts,
} from "@/lib/pr/pr-attention-queue";
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
} from "@/components/epic-canvas/pr/pr-detail-tone";
import { PrOwnerBadges } from "@/components/epic-canvas/pr/pr-owner-label";
import { usePresentPrOwners } from "@/hooks/pr/use-present-pr-owners";
import { EpicSessionGate } from "@/providers/epic-session-gate";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
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
  readonly epicId: string;
  readonly notLive: boolean;
  readonly className: string | undefined;
}

/**
 * The context card: the second column of the detail shell's row, sticky as the
 * document scrolls.
 *
 * It carries the facts a reader consults rather than reads: the proportional
 * check meter, the review decision, per-reviewer state, the size and freshness
 * of the change, and the chats it came from.
 *
 * Those last two moved DOWN here from the header. The header now pins itself
 * to the top of the scroll, and a pinned bar has to earn every line it spends:
 * "which PR" and "what is it merging into" are re-read constantly while
 * scrolling a diff, whereas "+47402 −1646" and "updated just now" are consulted
 * once. A sticky bar is the wrong home for a fact you look at once; a sidebar
 * that is always in view is the right one.
 *
 * Below the container-width threshold the card is simply absent, and nothing
 * takes its place. Checks reach the reader through the tab badge and the Checks
 * tab, reviewers through Feedback, and the diffstat through the Files tab - so
 * its absence costs convenience, never capability.
 */
export function PrDetailCard(props: PrDetailCardProps): ReactNode {
  const reviewers = prReviewerRows(props.core, props.activity);
  // A tile is bound to its host for life (CLAUDE.md, host identity rule 2).
  const tabHostId = useTabHostId();
  return (
    <div
      data-testid="pr-detail-card"
      className={cn(
        "flex min-w-0 flex-col rounded-xl border border-border/70 bg-canvas p-3 text-ui-xs shadow-lg",
        props.className,
      )}
    >
      {/* Still no state row and no branches: the pinned header carries both,
          and a card beside the thing it repeats doubles the reading without
          adding a fact. */}
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
      <PrCardSection heading="Change">
        <div className="flex flex-col gap-1">
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
          {props.core.commentCount !== null ? (
            <PrCardGauge
              label="Comments"
              value={props.core.commentCount}
              valueClassName={undefined}
            />
          ) : null}
          {props.notLive ? (
            <PrCardGauge
              label="Liveness"
              value={<span data-testid="pr-detail-not-live">Not live</span>}
              valueClassName="text-muted-foreground"
            />
          ) : null}
        </div>
      </PrCardSection>
      {/* The chats this PR came from, as the SAME clickable pills the panel row
          renders. They answer "which conversation produced this?" - a question
          a reader returns to, which is why they sit in the always-visible card
          rather than in a header that scrolls past. */}
      {props.core.owners.length > 0 ? (
        <EpicSessionGate fallback={null}>
          <PrOwnerCardSection
            owners={props.core.owners}
            epicId={props.epicId}
            fallbackHostId={tabHostId}
          />
        </EpicSessionGate>
      ) : null}
    </div>
  );
}

/**
 * The "Chats" section, present only when an owner survives to fill it.
 *
 * The raw owner array cannot decide that. A PR keeps naming chats the user
 * deleted (worktree bindings cascade on epic delete, not on chat delete), and
 * `PrOwnerBadges` drops those - so gating the section on `core.owners` would
 * leave a bordered heading standing over nothing for exactly the all-deleted
 * case the dropping exists to clean up. The heading has to answer to the same
 * surviving set its contents do.
 *
 * Re-filtering inside `PrOwnerBadges` is free: `usePresentPrOwners` returns the
 * caller's own array when it drops nothing, so the second pass is identity-
 * stable and re-renders no chip.
 */
function PrOwnerCardSection(props: {
  readonly owners: PrDetailCore["owners"];
  readonly epicId: string;
  readonly fallbackHostId: string | null;
}): ReactNode {
  const owners = usePresentPrOwners(props.owners);
  if (owners.length === 0) return null;
  return (
    <PrCardSection heading="Chats">
      <PrOwnerBadges
        owners={owners}
        epicId={props.epicId}
        fallbackHostId={props.fallbackHostId}
        className={undefined}
      />
    </PrCardSection>
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
