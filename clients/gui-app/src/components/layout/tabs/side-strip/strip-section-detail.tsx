import type { ReactNode } from "react";
import { Check, X } from "lucide-react";
import { displayTitle } from "@/lib/display-title";
import { cn } from "@/lib/utils";
import type { NeedsYouReason } from "@/stores/notifications/needs-you-items";
import type { NeedsYouRow, ToReviewRow } from "./strip-sections";

/** Both lines' type: 12px, on the row's 16px line. */
const DETAIL_CLASS = "flex min-w-0 items-center gap-1.5 text-ui-xs leading-4";

/** The one word a request asks of the person. */
const NEEDS_YOU_VERB: Readonly<Record<NeedsYouReason, string>> = {
  approval: "Approve",
  reply: "Reply",
};

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
      <span className="min-w-0 truncate">{text}</span>
      {row.count > 1 ? (
        <span className="shrink-0 tabular-nums">+{row.count - 1}</span>
      ) : null}
    </span>
  );
}

/** A green check and "Done · ready to review", or a red cross and "Failed". */
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
      <span className="min-w-0 truncate">
        {done ? "Done · ready to review" : "Failed"}
      </span>
    </span>
  );
}
