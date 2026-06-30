import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useChatMeasuredOpenChange } from "@/components/chat/chat-measured-item-change-context";
import { cn } from "@/lib/utils";

interface SegmentCardProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  header: ReactNode;
  headerAction: ReactNode | null;
  collapsedPreview: ReactNode | null;
  body: ReactNode;
  tone: "default" | "destructive" | "primary";
  headerPosition: "normal" | "sticky";
  bodyOverflow: "hidden" | "visible";
  headerFindUnitId: string | null;
  bodyFindUnitId: string | null;
  // When false the card is a static header with no toggle/chevron and no body -
  // for segments whose collapsed header already says everything (e.g. a tool
  // call whose summary captures the whole input).
  expandable: boolean;
  className: string | undefined;
}

const TONE_CLASS: Record<SegmentCardProps["tone"], string> = {
  default: "border-border/40 bg-muted/30",
  destructive: "border-destructive/30 bg-destructive/5",
  primary: "border-primary/40 bg-primary/5",
};

/**
 * Shared segment shell - chip→card chrome with a collapsible body. Header is
 * always visible; body slides in/out via Radix Collapsible. Does not render
 * its own toggle button - the entire header is the click target.
 */
export function SegmentCard(props: SegmentCardProps) {
  const {
    header,
    headerAction,
    collapsedPreview,
    tone,
    headerFindUnitId,
    expandable,
    className,
  } = props;
  if (!expandable) {
    return (
      <div
        className={cn(
          "rounded-md border text-ui-sm",
          TONE_CLASS[tone],
          className,
        )}
      >
        <div className="flex w-full items-stretch overflow-hidden rounded-md">
          <div
            data-chat-find-unit={headerFindUnitId ?? undefined}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2 overflow-hidden px-2.5 py-2",
              headerAction === null ? "rounded-md" : "rounded-l-md",
            )}
          >
            <span className="relative flex min-w-0 flex-1 items-center gap-2">
              {header}
            </span>
          </div>
          {headerAction}
        </div>
        {collapsedPreview !== null ? (
          <div className="border-t border-border/25 px-2.5 py-2">
            {collapsedPreview}
          </div>
        ) : null}
      </div>
    );
  }
  return <ExpandableSegmentCard {...props} />;
}

function ExpandableSegmentCard(props: SegmentCardProps) {
  const {
    open,
    onOpenChange,
    header,
    headerAction,
    collapsedPreview,
    body,
    tone,
    headerPosition,
    bodyOverflow,
    headerFindUnitId,
    bodyFindUnitId,
    className,
  } = props;
  const measuredOpenChange = useChatMeasuredOpenChange(onOpenChange);
  return (
    <Collapsible
      open={open}
      onOpenChange={measuredOpenChange}
      className={cn(
        "rounded-md border text-ui-sm",
        TONE_CLASS[tone],
        "transition-colors",
        className,
      )}
    >
      <div
        className={cn(
          "flex w-full items-stretch overflow-hidden rounded-md",
          headerPosition === "sticky" &&
            open &&
            "sticky top-0 z-20 bg-background shadow-sm",
          open ? "rounded-b-none border-b border-border/30" : null,
        )}
      >
        <CollapsibleTrigger
          data-find-include="true"
          data-chat-find-unit={headerFindUnitId ?? undefined}
          className={cn(
            "group/segment-card relative flex min-w-0 flex-1 items-center gap-2 overflow-hidden px-2.5 py-2 text-left transition-colors hover:bg-muted/40",
            headerAction === null ? "rounded-md" : "rounded-l-md",
            open ? "rounded-b-none" : null,
          )}
        >
          <span className="relative flex min-w-0 flex-1 items-center gap-2">
            {header}
          </span>
          <ChevronDown
            aria-hidden
            className={cn(
              "relative size-3.5 shrink-0 text-muted-foreground/70 transition-transform",
              "group-data-[state=open]/segment-card:rotate-180",
            )}
          />
        </CollapsibleTrigger>
        {headerAction}
      </div>
      {!open && collapsedPreview !== null ? (
        <div className="border-t border-border/25 px-2.5 py-2">
          {collapsedPreview}
        </div>
      ) : null}
      <CollapsibleContent
        className={bodyOverflow === "hidden" ? "overflow-hidden" : undefined}
      >
        <div
          data-chat-find-unit={bodyFindUnitId ?? undefined}
          className="px-2.5 pt-2 pb-2.5"
        >
          {body}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
