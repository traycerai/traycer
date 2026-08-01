import { useCallback, type ReactNode } from "react";
import {
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  CircleSlash,
  Clock,
  Minus,
  Plus,
  TextQuote,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type {
  PrChangedFile,
  PrCheckContext,
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
import { formatPrCheckStatusLabel } from "@/lib/pr/pr-detail-projection";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  formatPrCheckName,
  groupPrChecks,
  prCheckContextKey,
  type PrCheckGroup,
  type PrCheckOutcome,
} from "@/lib/pr/pr-check-groups";
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
 * Patch content is absent from the `pr.subscribeDetail` contract
 * (`prFilesSectionSchema`) because GitHub's GraphQL `PullRequestChangedFile`
 * has no patch field to carry, so this view can never render a diff from the
 * sweep alone. `pr.getLocalDiff` supplies one from the local checkout when
 * there is one; this list is what a reader sees when there isn't, and the
 * `footer` is where that gets explained (see `PrDetailFilesTab`).
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
  /** Control on the list's header rail - the "Open diff" tile opener. */
  readonly headerAction: ReactNode;
  /**
   * The line under the list explaining where the diff itself lives. Passed in
   * rather than built here so this component stays a list and nothing else.
   */
  readonly footer: ReactNode;
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
          {props.headerAction}
        </div>
        <ul className="divide-y divide-border/40">
          {props.files.files.map((file) => (
            <li
              key={file.path}
              className="group flex min-w-0 items-center gap-2 px-3 py-2 text-ui-xs"
              data-testid="pr-detail-file-row"
            >
              <PrFileChangeGlyph changeType={file.changeType} />
              <TooltipWrapper
                label={file.path}
                side="top"
                sideOffset={undefined}
                align={undefined}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-foreground">
                  {file.path}
                </span>
              </TooltipWrapper>
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
      {props.footer}
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
  const groups = groupPrChecks(props.checks.contexts);

  return (
    <div
      className="min-w-0 overflow-hidden rounded-xl border border-border/60 bg-canvas"
      data-testid="pr-detail-checks"
    >
      <div className="flex min-w-0 items-center gap-2 border-b border-border/50 bg-muted/25 px-3 py-2 text-ui-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">
          {props.checks.contexts.length} check
          {props.checks.contexts.length === 1 ? "" : "s"}
          {props.checks.isTruncated ? " \u00b7 showing the first 50" : ""}
        </span>
        <span className={cn("shrink-0", PR_TONE_TEXT_CLASS[tone])}>
          {formatPrChecksValue(props.counts)}
        </span>
      </div>
      <div className="min-w-0">
        {groups.map((group) => (
          <PrCheckGroupSection
            key={group.outcome}
            group={group}
            onOpenDetails={props.onOpenDetails}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One outcome group. Every group starts EXPANDED - the grouping is there to
 * order and label the rows, not to hide them, and a check you have to click to
 * see is a check you have to know to look for. The heading still collapses on
 * demand once a reader has decided a group is not interesting.
 */
function PrCheckGroupSection(props: {
  readonly group: PrCheckGroup;
  readonly onOpenDetails: (url: string) => void;
}): ReactNode {
  const { group } = props;
  return (
    <details
      open
      className="min-w-0 border-b border-border/40 last:border-b-0"
      data-testid="pr-detail-check-group"
      data-outcome={group.outcome}
    >
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-ui-xs text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight
          className="size-3.5 shrink-0 transition-transform in-open:rotate-90"
          aria-hidden
        />
        <span className="min-w-0 truncate">{group.heading}</span>
      </summary>
      <ul className="min-w-0 divide-y divide-border/40 border-t border-border/40">
        {group.contexts.map((context, index) => (
          <PrCheckRow
            key={prCheckContextKey(context, index)}
            context={context}
            outcome={group.outcome}
            onOpenDetails={props.onOpenDetails}
          />
        ))}
      </ul>
    </details>
  );
}

const OUTCOME_GLYPH: Record<
  PrCheckOutcome,
  {
    readonly Icon: LucideIcon;
    readonly tone: "ok" | "fail" | "pending" | "none";
  }
> = {
  failing: { Icon: XCircle, tone: "fail" },
  pending: { Icon: Clock, tone: "pending" },
  // Not a check mark. A skipped job did not run, and a green tick over it
  // claims a pass that never happened - which is what the previous list did.
  skipped: { Icon: CircleSlash, tone: "none" },
  successful: { Icon: CheckCircle2, tone: "ok" },
};

/**
 * One check.
 *
 * The NAME is the link - the whole row's subject is "this check", and the
 * thing a reader wants to click is the thing they just read. The trailing
 * icon-button it replaces was a second, smaller target for the same
 * destination, sitting where the eye had already stopped.
 */
function PrCheckRow(props: {
  readonly context: PrCheckContext;
  readonly outcome: PrCheckOutcome;
  readonly onOpenDetails: (url: string) => void;
}): ReactNode {
  const { context, outcome } = props;
  const glyph = OUTCOME_GLYPH[outcome];
  const label = formatPrCheckName(context);
  const { onOpenDetails } = props;
  const open = useCallback((): void => {
    if (context.detailsUrl !== null) onOpenDetails(context.detailsUrl);
  }, [context.detailsUrl, onOpenDetails]);

  return (
    <li className="flex min-w-0 items-center gap-2 px-3 py-2 text-ui-xs">
      <glyph.Icon
        className={cn("size-4 shrink-0", PR_TONE_TEXT_CLASS[glyph.tone])}
        aria-hidden
        data-testid="pr-detail-check-dot"
      />
      <PrCheckAppMark context={context} />
      {context.detailsUrl === null ? (
        <span
          className="min-w-0 flex-1 truncate text-foreground"
          data-testid="pr-detail-check-name"
        >
          {label}
        </span>
      ) : (
        <TooltipWrapper
          label={label}
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <button
            type="button"
            onClick={open}
            data-testid="pr-detail-check-name"
            className="min-w-0 flex-1 truncate text-left text-foreground transition-colors hover:text-primary hover:underline focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
          >
            {label}
          </button>
        </TooltipWrapper>
      )}
      {context.description !== null && context.description.length > 0 ? (
        <span className="hidden min-w-0 max-w-[16ch] shrink truncate text-muted-foreground/70 @min-[34rem]:inline">
          {context.description}
        </span>
      ) : null}
      <span className={cn("shrink-0", PR_TONE_TEXT_CLASS[glyph.tone])}>
        {formatPrCheckStatusLabel(context)}
      </span>
    </li>
  );
}

/**
 * The reporting app's mark, which is how a list of fourteen rows is scanned:
 * finding the one CodeRabbit row among twelve Actions rows is a glance rather
 * than a read. Falls back to nothing at all when the app served no icon -
 * a generic placeholder would add noise without adding a distinction.
 */
function PrCheckAppMark(props: {
  readonly context: PrCheckContext;
}): ReactNode {
  const { appLogoUrl, appName } = props.context;
  if (appLogoUrl === null || appLogoUrl.length === 0) return null;
  return (
    <TooltipWrapper
      label={appName}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <img
        src={appLogoUrl}
        alt=""
        aria-hidden
        loading="lazy"
        data-testid="pr-detail-check-app-mark"
        className="size-4 shrink-0 rounded-sm bg-muted/40 object-contain"
      />
    </TooltipWrapper>
  );
}
