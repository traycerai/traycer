import type { ReactNode } from "react";
import { Check, X } from "lucide-react";
import { displayTitle } from "@/lib/display-title";
import { cn } from "@/lib/utils";
import { StripElapsedTime } from "./strip-elapsed-time";
import {
  NEEDS_YOU_VERB,
  type NeedsYouRow,
  type ToReviewRow,
} from "./strip-sections";

/** Both lines' type: 12px, on the row's 16px line. */
const DETAIL_CLASS = "flex min-w-0 items-center gap-1.5 text-ui-xs leading-4";

/**
 * The line's words fade at the edge, as the title above does, rather than end
 * in an ellipsis. The fade is the last 1.25rem of the text's own box, so the
 * box takes the room the line has (a "+N" after it sits at the line's end) and
 * short words leave the fade over empty space.
 */
const DETAIL_TEXT_CLASS = "header-tab-title-text min-w-0 flex-1";

/** "Approve · agent" or "Reply · agent", with "+N" for the other requests. */
export function NeedsYouDetail(props: {
  readonly row: NeedsYouRow;
}): ReactNode {
  const { row } = props;
  const verb = NEEDS_YOU_VERB[row.reason];
  const text =
    row.agentTitle === null
      ? verb
      : `${verb} · ${displayTitle(row.agentTitle, "agent")}`;
  return (
    <span
      data-testid="side-tab-section-detail"
      className={cn(DETAIL_CLASS, "text-warning-foreground")}
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />
      <span className={DETAIL_TEXT_CLASS}>{text}</span>
      {row.count > 1 ? (
        <span className="shrink-0 tabular-nums">+{row.count - 1}</span>
      ) : null}
    </span>
  );
}

/** A half of a split pair that needs the person, and its task's title. */
export interface PairNeedsYouHalf {
  readonly row: NeedsYouRow;
  readonly title: string;
}

/**
 * A split pair's second line: "Approve · task · agent" for the half that has
 * waited longest (the left one on a tie), ending in "· +1 more" when the other
 * half needs the person too. `null` when neither does.
 */
export function PairNeedsYouDetail(props: {
  readonly halves: ReadonlyArray<PairNeedsYouHalf>;
  readonly className: string;
}): ReactNode {
  const first = props.halves.reduce<PairNeedsYouHalf | null>(
    (oldest, half) =>
      oldest === null || waitedLonger(half.row, oldest.row) ? half : oldest,
    null,
  );
  if (first === null) return null;
  const { row } = first;
  const words = [
    NEEDS_YOU_VERB[row.reason],
    first.title,
    ...(row.agentTitle === null ? [] : [displayTitle(row.agentTitle, "agent")]),
  ];
  return (
    <span
      data-testid="side-tab-section-detail"
      className={cn(DETAIL_CLASS, "text-warning-foreground", props.className)}
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />
      <span className={DETAIL_TEXT_CLASS}>{words.join(" · ")}</span>
      {props.halves.length > 1 ? (
        <span className="shrink-0">· +1 more</span>
      ) : null}
    </span>
  );
}

/** Whether `a` has waited longer than `b`; a request with no time loaded has waited least. */
function waitedLonger(a: NeedsYouRow, b: NeedsYouRow): boolean {
  if (a.createdAt === null) return false;
  return b.createdAt === null || a.createdAt < b.createdAt;
}

/**
 * A green check and "Done", or a red cross and "Failed": the section's header
 * already says it is to review.
 */
export function ToReviewDetail(props: {
  readonly row: ToReviewRow;
}): ReactNode {
  const done = props.row.outcome === "done";
  return (
    <span
      data-testid="side-tab-section-detail"
      className={cn(DETAIL_CLASS, "text-muted-foreground")}
    >
      {done ? (
        <Check
          aria-hidden
          className="size-3 shrink-0 text-success-foreground"
        />
      ) : (
        <X aria-hidden className="size-3 shrink-0 text-destructive" />
      )}
      <span className={DETAIL_TEXT_CLASS}>{done ? "Done" : "Failed"}</span>
    </span>
  );
}

/**
 * A rail tile's card for a Needs you or To review task: the title, the second
 * line its row would draw, and the wait or how long ago it finished.
 */
export function RailSectionCard(props: {
  readonly title: string;
  readonly row: NeedsYouRow | ToReviewRow;
}): ReactNode {
  const { row } = props;
  const waiting = row.section === "needs-you";
  const since = waiting ? row.createdAt : row.at;
  return (
    <div
      data-testid="side-tab-hover-card-body"
      className="flex flex-col gap-1.5"
    >
      <div className="text-ui-sm font-medium break-words text-foreground">
        {props.title}
      </div>
      {waiting ? <NeedsYouDetail row={row} /> : <ToReviewDetail row={row} />}
      {since === null ? null : (
        <div className="text-muted-foreground">
          {waiting ? "Waiting " : null}
          <StripElapsedTime
            since={since}
            className="tabular-nums"
            testId="side-tab-hover-card-time"
          />
          {waiting ? null : " ago"}
        </div>
      )}
    </div>
  );
}
