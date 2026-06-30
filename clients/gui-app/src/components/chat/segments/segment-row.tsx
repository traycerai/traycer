import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useChatMeasuredOpenChange } from "@/components/chat/chat-measured-item-change-context";
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
  // When false the row is a static header with no toggle/chevron and no body
  // (a chevron-width spacer keeps it aligned with sibling expandable rows). The
  // footer still renders. For nested tool activity whose header already says
  // everything.
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
  if (!expandable) {
    return (
      <div className={cn("group/work-row", className)}>
        <div
          data-chat-find-unit={headerFindUnitId ?? undefined}
          className={cn(
            "flex w-full items-center gap-2 rounded-sm px-1 py-1 text-ui-sm",
            tone === "destructive" && "text-destructive",
          )}
        >
          <span aria-hidden className="size-3 shrink-0" />
          <span className="relative flex min-w-0 flex-1 items-center gap-2">
            {header}
          </span>
        </div>
        {footer !== null ? <div className="ml-5 pb-1">{footer}</div> : null}
      </div>
    );
  }
  return <ExpandableSegmentRow {...props} />;
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
  const measuredOpenChange = useChatMeasuredOpenChange(onOpenChange);
  return (
    <Collapsible
      open={open}
      onOpenChange={measuredOpenChange}
      className={cn("group/work-row", className)}
    >
      <CollapsibleTrigger
        data-find-include="true"
        data-chat-find-unit={headerFindUnitId ?? undefined}
        className={cn(
          "flex w-full items-center gap-2 rounded-sm px-1 py-1 text-left text-ui-sm transition-colors",
          // The sticky header floats over scrolled content, so its hover tint
          // must stay opaque - a translucent bg lets the content bleed through.
          stickyHeader && open
            ? "sticky top-0 z-20 border-b border-border/40 bg-background shadow-sm hover:bg-[color-mix(in_oklch,var(--muted)_40%,var(--background))]"
            : "hover:bg-muted/40",
          tone === "destructive" && "text-destructive",
        )}
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-muted-foreground/50 transition-transform",
            "group-data-[state=open]/work-row:rotate-90",
          )}
        />
        <span className="relative flex min-w-0 flex-1 items-center gap-2">
          {header}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div
          data-chat-find-unit={bodyFindUnitId ?? undefined}
          className="mt-1 mb-1.5 ml-4"
        >
          {body}
        </div>
      </CollapsibleContent>
      {footer !== null ? <div className="ml-5 pb-1">{footer}</div> : null}
    </Collapsible>
  );
}
