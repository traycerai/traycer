import type { ReactNode } from "react";
import {
  ArrowRight,
  Check,
  Clock,
  ExternalLink,
  Minus,
  Plus,
  TextQuote,
  X,
  type LucideIcon,
} from "lucide-react";
import type {
  PrChangedFile,
  PrChecksSection,
  PrDetailCore,
  PrFilesSection,
} from "@traycer/protocol/host/pr-schemas";
import type { PrCheckCounts } from "@/lib/pr/pr-attention-queue";
import {
  formatPrChecksValue,
  PR_DIFF_ADDED_CLASS,
  PR_DIFF_REMOVED_CLASS,
  PR_TONE_CHIP_CLASS,
  PR_TONE_FILL_CLASS,
  PR_TONE_TEXT_CLASS,
  prChecksTone,
  prReviewDecisionTone,
} from "@/components/epic-canvas/pr/pr-detail-tone";
import {
  formatPrCheckStatusLabel,
  prCheckContextDotTone,
} from "@/lib/pr/pr-detail-projection";
import { cn } from "@/lib/utils";

/**
 * Reference tabs: Files changed and Checks.
 *
 * Both are lists of rows inside one bordered card - the same shell the
 * conversation surfaces use - rather than GitHub's collapsible box with its
 * own inner scroller. The tab body already scrolls, so a nested scroll region
 * only produces the trapped-wheel behaviour where the page stops moving over
 * a list and the reader has to aim around it.
 */

// ---- Files changed --------------------------------------------------------- //

function PrFileChangeGlyph(props: {
  readonly changeType: PrChangedFile["changeType"];
}): ReactNode {
  if (props.changeType === "added") {
    return (
      <Plus
        className={cn("size-3.5 shrink-0", PR_DIFF_ADDED_CLASS)}
        aria-hidden
      />
    );
  }
  if (props.changeType === "deleted") {
    return (
      <Minus
        className={cn("size-3.5 shrink-0", PR_DIFF_REMOVED_CLASS)}
        aria-hidden
      />
    );
  }
  if (props.changeType === "renamed" || props.changeType === "copied") {
    return (
      <ArrowRight
        className="size-3.5 shrink-0 text-muted-foreground"
        aria-hidden
      />
    );
  }
  return (
    <span
      className={cn(
        "mx-0.5 size-2.5 shrink-0 rounded-xs",
        PR_TONE_FILL_CLASS.pending,
      )}
      aria-hidden
    />
  );
}

/**
 * The changed-file list: paths, change type and per-file counts.
 *
 * Patch content is deliberately absent from the `pr.subscribeDetail` contract
 * (`prFilesSectionSchema`), so this cannot render the diff itself yet - and it
 * says so in one line rather than leaving the reader to wonder whether the
 * diff failed to load. The link out is the honest escape hatch until the wire
 * carries patches.
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
  /** `null` when no chat is selected to send to, which disables the row action. */
  readonly onQuoteFile: ((file: PrChangedFile) => void) | null;
}): ReactNode {
  if (props.files.files.length === 0) {
    return (
      <p
        className="rounded-xl border border-dashed border-border/60 py-10 text-center text-ui-sm text-muted-foreground/70"
        data-testid="pr-detail-files-empty"
      >
        No changed files reported.
      </p>
    );
  }
  const shownCount = props.files.files.length;
  const totalCount = props.files.totalCount ?? shownCount;
  const additions =
    props.additions ??
    props.files.files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions =
    props.deletions ??
    props.files.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="pr-detail-files">
      <div className="min-w-0 overflow-hidden rounded-xl border border-border/60 bg-canvas">
        <div className="flex min-w-0 items-center gap-2 border-b border-border/50 bg-muted/25 px-3 py-2 text-ui-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">
            {totalCount} file{totalCount === 1 ? "" : "s"} changed
            {totalCount > shownCount
              ? ` · showing the first ${shownCount}`
              : ""}
          </span>
          <span className="shrink-0 font-mono">
            <span className={PR_DIFF_ADDED_CLASS}>+{additions}</span>{" "}
            <span className={PR_DIFF_REMOVED_CLASS}>−{deletions}</span>
          </span>
        </div>
        <ul className="divide-y divide-border/40">
          {props.files.files.map((file) => (
            <li
              key={file.path}
              className="group flex min-w-0 items-center gap-2 px-3 py-2 text-ui-xs"
              data-testid="pr-detail-file-row"
            >
              <PrFileChangeGlyph changeType={file.changeType} />
              <span
                className="min-w-0 flex-1 truncate font-mono text-foreground"
                title={file.path}
              >
                {file.path}
              </span>
              {props.onQuoteFile !== null ? (
                <PrFileQuoteButton file={file} onQuote={props.onQuoteFile} />
              ) : null}
              <span className="shrink-0 font-mono text-muted-foreground">
                {file.additions !== null ? (
                  <span className={PR_DIFF_ADDED_CLASS}>+{file.additions}</span>
                ) : null}{" "}
                {file.deletions !== null ? (
                  <span className={PR_DIFF_REMOVED_CLASS}>
                    −{file.deletions}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      </div>
      {props.prUrl !== null ? (
        <p className="px-1 text-ui-xs text-muted-foreground/70">
          Line-by-line changes are not carried in this view yet.{" "}
          <a
            href={`${props.prUrl}/files`}
            target="_blank"
            rel="noreferrer"
            className="text-primary hover:underline"
          >
            View the full diff on GitHub
          </a>
        </p>
      ) : null}
    </div>
  );
}

/** Row-level quote affordance; revealed on hover, always reachable by keyboard. */
function PrFileQuoteButton(props: {
  readonly file: PrChangedFile;
  readonly onQuote: (file: PrChangedFile) => void;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={() => props.onQuote(props.file)}
      aria-label={`Quote ${props.file.path} into the selected chat`}
      data-testid="pr-detail-file-quote"
      className="shrink-0 rounded p-0.5 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground hover:text-foreground focus-visible:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
    >
      <TextQuote className="size-3" aria-hidden />
    </button>
  );
}

// ---- Checks ---------------------------------------------------------------- //

const CHECKS_HEADLINE: Record<
  "ok" | "fail" | "pending" | "none",
  { readonly title: string; readonly Icon: LucideIcon }
> = {
  ok: { title: "All checks have passed", Icon: Check },
  fail: { title: "Some checks were not successful", Icon: X },
  pending: { title: "Some checks haven't finished", Icon: Clock },
  none: { title: "No checks reported", Icon: Clock },
};

/**
 * The Checks tab: one health card carrying the rollup and review decision,
 * then the per-check list. Replaces GitHub's merge box, which is shaped around
 * the merge BUTTON - the one thing a read-only view has no business implying
 * it can do.
 */
export function PrDetailChecks(props: {
  readonly core: PrDetailCore;
  readonly checks: PrChecksSection;
  readonly counts: PrCheckCounts;
  readonly onOpenDetails: (url: string) => void;
}): ReactNode {
  const tone = prChecksTone(props.counts);
  const headline = CHECKS_HEADLINE[tone];

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="pr-detail-checks">
      <div
        className={cn(
          "flex min-w-0 items-center gap-3 rounded-xl border px-3 py-3",
          tone === "ok" && "border-success/25 bg-success/5",
          tone === "fail" && "border-destructive/30 bg-destructive/5",
          tone === "pending" && "border-warning/25 bg-warning/5",
          tone === "none" && "border-border/60",
        )}
      >
        <headline.Icon
          className={cn("size-5 shrink-0", PR_TONE_TEXT_CLASS[tone])}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="text-ui-sm font-medium text-foreground">
            {headline.title}
          </p>
          <p className="text-ui-xs text-muted-foreground">
            {formatPrChecksValue(props.counts)}
            {props.checks.isTruncated ? " · showing the first 50" : ""}
          </p>
        </div>
        {props.core.reviewDecision !== null ? (
          <span
            className={cn(
              "shrink-0 rounded-full border px-2 py-0.5 text-ui-xs",
              PR_TONE_CHIP_CLASS[
                prReviewDecisionTone(props.core.reviewDecision)
              ],
            )}
          >
            {REVIEW_DECISION_LABEL[props.core.reviewDecision]}
          </span>
        ) : null}
      </div>
      {props.checks.contexts.length === 0 ? null : (
        <ul className="min-w-0 divide-y divide-border/40 overflow-hidden rounded-xl border border-border/60 bg-canvas">
          {props.checks.contexts.map((context) => {
            const contextTone = prCheckContextDotTone(context);
            return (
              <li
                key={context.name}
                className="flex min-w-0 items-center gap-2 px-3 py-2 text-ui-xs"
              >
                <PrCheckToneGlyph tone={contextTone} />
                <span className="min-w-0 flex-1 truncate font-mono text-foreground">
                  {context.name}
                </span>
                <span
                  className={cn("shrink-0", PR_TONE_TEXT_CLASS[contextTone])}
                >
                  {formatPrCheckStatusLabel(context)}
                </span>
                {context.detailsUrl !== null ? (
                  <PrCheckDetailsButton
                    name={context.name}
                    url={context.detailsUrl}
                    onOpenDetails={props.onOpenDetails}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const REVIEW_DECISION_LABEL = {
  approved: "Approved",
  changes_requested: "Changes requested",
  review_required: "Review required",
} as const;

function PrCheckToneGlyph(props: {
  readonly tone: "ok" | "fail" | "pending" | "none";
}): ReactNode {
  if (props.tone === "ok" || props.tone === "fail") {
    const Icon = props.tone === "ok" ? Check : X;
    return (
      <Icon
        className={cn("size-4 shrink-0", PR_TONE_TEXT_CLASS[props.tone])}
        aria-hidden
        data-testid="pr-detail-check-dot"
      />
    );
  }
  return (
    <span
      className={cn(
        "mx-1 size-2 shrink-0 rounded-full",
        PR_TONE_FILL_CLASS[props.tone],
      )}
      aria-hidden
      data-testid="pr-detail-check-dot"
    />
  );
}

function PrCheckDetailsButton(props: {
  readonly name: string;
  readonly url: string;
  readonly onOpenDetails: (url: string) => void;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={() => props.onOpenDetails(props.url)}
      aria-label={`Open ${props.name} on GitHub`}
      data-testid="pr-detail-check-details"
      className="inline-flex shrink-0 items-center rounded p-0.5 text-muted-foreground transition-colors hover:text-primary focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
    >
      <ExternalLink className="size-3" aria-hidden />
    </button>
  );
}
