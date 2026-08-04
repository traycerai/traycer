import { ChevronRight } from "lucide-react";
import { useCallback, type ReactNode } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useLiveActivityPromote } from "./live-activity-promote-context";
import { cn } from "@/lib/utils";

interface SegmentRowProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  header: ReactNode;
  body: ReactNode;
  tone: "default" | "destructive";
  stickyHeader: boolean;
  headerFindUnitId: string | null;
  bodyFindUnitId: string | null;
  // When false the row is a static header with no toggle, no caret and no body;
  // the footer still renders. It needs no spacer to line up with its expandable
  // siblings, because their caret trails rather than leads. For nested tool
  // activity whose header already says everything.
  expandable: boolean;
  className: string | undefined;
  // Always-visible content rendered beneath the row, regardless of open state
  // (e.g. a streaming heartbeat). Indented to align under the header. Null when
  // the row has no footer.
  footer: ReactNode | null;
}

/**
 * Bare collapsible row for nested chat activity. No outer border or card
 * background - the parent timeline item provides hierarchy. Body is indented
 * under the row when open; an optional `footer` sits beneath the row always.
 */
export function SegmentRow(props: SegmentRowProps) {
  const { header, tone, className, headerFindUnitId } = props;
  const { expandable, footer } = props;
  const promote = useLiveActivityPromote();
  if (expandable && promote !== null) {
    return <PromotingSegmentRow {...props} promote={promote} />;
  }
  if (!expandable) {
    return (
      <div className={cn("group/work-row", className)}>
        <div
          data-row-header=""
          data-chat-find-unit={headerFindUnitId ?? undefined}
          className={cn(
            "flex w-full items-center gap-2 rounded-sm px-1 py-1 text-ui-sm",
            tone === "destructive" && "text-destructive",
          )}
        >
          {/* No leading spacer: with the caret moved to the trailing edge,
              nothing occupies that column on an expandable sibling either, so
              every row's icon starts flush at `px-1`. */}
          <span className="relative flex min-w-0 flex-1 items-center gap-2">
            {header}
          </span>
        </div>
        {footer !== null ? (
          <div data-testid="segment-row-footer" className="ml-5 pb-1">
            {footer}
          </div>
        ) : null}
      </div>
    );
  }
  return <ExpandableSegmentRow {...props} />;
}

/**
 * `data-row-header` marks the header LINE on all three branches above - the
 * plain div, the promoting button and the collapsible trigger. Placement tests
 * ("the elapsed counter rides the header row, the progress line does not") need
 * one anchor that means the same thing whichever branch rendered, and neither
 * `parentElement` nor `closest("button")` is that: the first depends on wrapper
 * depth inside each header, and the second silently returns null for the
 * non-expandable row, which is the branch a streaming tool actually takes.
 */

/**
 * The disclosure caret every activity row shares: trailing, and invisible until
 * the row is hovered, focused or open.
 *
 * It used to lead the row, which put a permanently-lit chevron in front of the
 * tool icon on every line of a run - two glyphs before the first word, and a
 * different shape from the thinking rows beside them, which carry their caret
 * on the right. Now nothing occupies the leading column on any row, so the
 * icons line up down the whole group.
 *
 * `rotateWhenOpen` is false for the promoting row: that click leaves the window
 * rather than unfolding anything, so a caret turning down would describe a
 * disclosure that never happens.
 */
function RowTrailingCaret(props: { readonly rotateWhenOpen: boolean }) {
  return (
    <ChevronRight
      aria-hidden
      // Named so the alignment tests can find it without walking
      // `lastElementChild`, which any new wrapper or sibling silently breaks.
      data-row-caret=""
      className={cn(
        "size-3.5 shrink-0 -translate-x-1 text-muted-foreground/65 opacity-0 transition-[opacity,transform,color]",
        "group-hover/row-trigger:translate-x-0 group-hover/row-trigger:text-foreground group-hover/row-trigger:opacity-100",
        "group-focus-visible/row-trigger:translate-x-0 group-focus-visible/row-trigger:text-foreground group-focus-visible/row-trigger:opacity-100",
        props.rotateWhenOpen &&
          "group-data-[state=open]/row-trigger:translate-x-0 group-data-[state=open]/row-trigger:rotate-90 group-data-[state=open]/row-trigger:text-foreground group-data-[state=open]/row-trigger:opacity-100",
      )}
    />
  );
}

/**
 * The same row, inside the bounded live activity window: it never opens a body
 * where it stands. Clicking marks the row open and promotes, which opens the
 * activity group - so the row reappears in the full-height body already
 * unfolded, instead of unfolding into a four-line box that clips it to one line.
 *
 * `onOpenChange(true)` only carries across the remount for rows whose open state
 * is store-backed by segment id (tool, subagent). The rest are seeded by the
 * group through `revealed`; see `LiveActivityPromoteContext`.
 *
 * Deliberately NOT a `Collapsible`: there is no body here to disclose, so a
 * trigger advertising `aria-expanded` would be lying about what the click does.
 */
function PromotingSegmentRow(
  props: SegmentRowProps & { readonly promote: () => void },
) {
  const { header, tone, className, headerFindUnitId, footer } = props;
  const { onOpenChange, promote } = props;
  const handleClick = useCallback((): void => {
    onOpenChange(true);
    promote();
  }, [onOpenChange, promote]);
  return (
    <div className={cn("group/work-row", className)}>
      <button
        type="button"
        onClick={handleClick}
        data-row-header=""
        data-activity-row-trigger=""
        data-find-include="true"
        data-chat-find-unit={headerFindUnitId ?? undefined}
        data-testid="activity-row-promote"
        className={cn(
          "group/row-trigger flex w-full items-center gap-2 rounded-sm px-1 py-1 text-left text-ui-sm transition-colors hover:bg-muted/40",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          tone === "destructive" && "text-destructive",
        )}
      >
        <span className="relative flex min-w-0 flex-1 items-center gap-2">
          {header}
        </span>
        <RowTrailingCaret rotateWhenOpen={false} />
      </button>
      {footer !== null ? (
        <div data-testid="segment-row-footer" className="ml-5 pb-1">
          {footer}
        </div>
      ) : null}
    </div>
  );
}

function ExpandableSegmentRow(props: SegmentRowProps) {
  const {
    open,
    onOpenChange,
    header,
    body,
    tone,
    stickyHeader,
    headerFindUnitId,
    bodyFindUnitId,
    className,
  } = props;
  const { footer } = props;
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className={cn("group/work-row", className)}
    >
      <CollapsibleTrigger
        data-row-header=""
        data-activity-row-trigger=""
        data-find-include="true"
        data-chat-find-unit={headerFindUnitId ?? undefined}
        className={cn(
          "group/row-trigger flex w-full items-center gap-2 rounded-sm px-1 py-1 text-left text-ui-sm transition-colors",
          // The sticky header floats over scrolled content, so its hover tint
          // must stay opaque - a translucent bg lets the content bleed through.
          stickyHeader && open
            ? "sticky top-0 z-20 border-b border-border/40 bg-background shadow-sm hover:bg-[color-mix(in_oklch,var(--muted)_40%,var(--background))]"
            : "hover:bg-muted/40",
          tone === "destructive" && "text-destructive",
        )}
      >
        <span className="relative flex min-w-0 flex-1 items-center gap-2">
          {header}
        </span>
        <RowTrailingCaret rotateWhenOpen />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div
          data-chat-find-unit={bodyFindUnitId ?? undefined}
          className="mt-1 mb-1.5 ml-4"
        >
          {body}
        </div>
      </CollapsibleContent>
      {footer !== null ? (
        <div data-testid="segment-row-footer" className="ml-5 pb-1">
          {footer}
        </div>
      ) : null}
    </Collapsible>
  );
}
