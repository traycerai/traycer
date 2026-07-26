import { type ReactNode } from "react";
import type { PrDetailCore } from "@traycer/protocol/host/pr-schemas";
import type { PrAttentionQueue } from "@/lib/pr/pr-attention-queue";
import type { PrQuoteTarget } from "@/lib/pr/pr-quote";
import {
  PR_DIFF_ADDED_CLASS,
  PR_DIFF_REMOVED_CLASS,
  PR_TONE_FILL_CLASS,
  PR_TONE_TEXT_CLASS,
  prStateTone,
} from "@/components/epic-canvas/pr/pr-detail-tone";
import { PrQuoteTargetPicker } from "@/components/epic-canvas/pr/pr-quote-target-picker";
import { cn } from "@/lib/utils";

/**
 * The card's degraded form, for the width state that has no gutter.
 *
 * This is the PRIMARY presentation, not a fallback. The card only exists above
 * a container-width threshold that plenty of real sessions never cross (a split
 * pane, a laptop window, the sidebar open), so the strip is what most readers
 * see most of the time. Everything load-bearing lives here; the card is its
 * wide-window expansion.
 *
 * What the card carries that this cannot: reviewer rows and the per-reviewer
 * state. Those stay reachable on the Feedback tab.
 */
export function PrDetailSummaryStrip(props: {
  readonly core: PrDetailCore;
  readonly queue: PrAttentionQueue;
  readonly target: PrQuoteTarget | null;
  readonly targets: readonly PrQuoteTarget[];
  readonly onSelectTarget: (target: PrQuoteTarget) => void;
}): ReactNode {
  const isDraft = props.core.state === "open" && props.core.isDraft === true;
  const stateTone = prStateTone(props.core);
  const failing = props.queue.checkCounts.failing;
  const blocking = props.queue.items.filter(
    (item) => item.kind === "changes-requested",
  ).length;

  return (
    <div
      data-testid="pr-detail-summary"
      className="flex w-full min-w-0 flex-wrap items-center gap-2 rounded-xl border border-border/50 bg-muted/25 px-3 py-2 text-ui-xs"
    >
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          PR_TONE_FILL_CLASS[stateTone],
        )}
        aria-hidden
      />
      <span className="shrink-0 font-medium text-foreground">
        {isDraft
          ? "Draft"
          : props.core.state.charAt(0).toUpperCase() +
            props.core.state.slice(1)}
      </span>
      {failing > 0 || blocking > 0 ? (
        <>
          <PrStripDivider />
          {failing > 0 ? (
            <span className={cn("shrink-0", PR_TONE_TEXT_CLASS.fail)}>
              {failing} failing
            </span>
          ) : null}
          {blocking > 0 ? (
            <span className={cn("shrink-0", PR_TONE_TEXT_CLASS.fail)}>
              {blocking} blocking
            </span>
          ) : null}
        </>
      ) : null}
      {props.core.additions !== null && props.core.deletions !== null ? (
        <>
          <PrStripDivider />
          <span className="shrink-0 font-mono">
            <span className={PR_DIFF_ADDED_CLASS}>+{props.core.additions}</span>{" "}
            <span className={PR_DIFF_REMOVED_CLASS}>
              −{props.core.deletions}
            </span>
          </span>
        </>
      ) : null}
      <PrStripDivider />
      <PrQuoteTargetPicker
        target={props.target}
        targets={props.targets}
        onSelectTarget={props.onSelectTarget}
        variant="compact"
      />
    </div>
  );
}

function PrStripDivider(): ReactNode {
  return (
    <span
      className="h-3 w-px shrink-0 bg-border/70"
      aria-hidden
      data-testid="pr-detail-summary-divider"
    />
  );
}
