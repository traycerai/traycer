import type { ReactNode } from "react";
import {
  ArrowRight,
  Check,
  ExternalLink,
  Minus,
  Plus,
  TextQuote,
  X,
} from "lucide-react";
import type {
  PrChangedFile,
  PrChecksSection,
  PrFilesSection,
} from "@traycer/protocol/host/pr-schemas";
import type { PrCheckCounts } from "@/lib/pr/pr-attention-queue";
import {
  formatPrChecksValue,
  PR_DIFF_ADDED_CLASS,
  PR_DIFF_REMOVED_CLASS,
  PR_TONE_FILL_CLASS,
  PR_TONE_TEXT_CLASS,
  prChecksTone,
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

/**
 * The Checks tab: the per-check list, and nothing above it.
 *
 * There was a headline card here - "Some checks were not successful", with the
 * failing count and the review decision - sitting directly on top of a list
 * whose first row was the failing check, in the same red. A summary is only
 * worth its space when it says something the thing below it doesn't; this one
 * restated the first row and the count of it. The counts moved into the list's
 * own header rail, which is where Files already carries its diffstat.
 *
 * (It also replaced GitHub's merge box, which is shaped around the merge
 * BUTTON - the one thing a read-only view has no business implying it can do.)
 */
export function PrDetailChecks(props: {
  readonly checks: PrChecksSection;
  readonly counts: PrCheckCounts;
  readonly onOpenDetails: (url: string) => void;
}): ReactNode {
  if (props.checks.contexts.length === 0) {
    return (
      <p
        className="rounded-xl border border-dashed border-border/60 py-10 text-center text-ui-sm text-muted-foreground/70"
        data-testid="pr-detail-checks-empty"
      >
        No checks reported for this pull request.
      </p>
    );
  }
  const tone = prChecksTone(props.counts);

  return (
    <div
      className="min-w-0 overflow-hidden rounded-xl border border-border/60 bg-canvas"
      data-testid="pr-detail-checks"
    >
      <div className="flex min-w-0 items-center gap-2 border-b border-border/50 bg-muted/25 px-3 py-2 text-ui-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">
          {props.checks.contexts.length} check
          {props.checks.contexts.length === 1 ? "" : "s"}
          {props.checks.isTruncated ? " · showing the first 50" : ""}
        </span>
        <span className={cn("shrink-0", PR_TONE_TEXT_CLASS[tone])}>
          {formatPrChecksValue(props.counts)}
        </span>
      </div>
      <ul className="min-w-0 divide-y divide-border/40">
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
              <span className={cn("shrink-0", PR_TONE_TEXT_CLASS[contextTone])}>
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
    </div>
  );
}

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
